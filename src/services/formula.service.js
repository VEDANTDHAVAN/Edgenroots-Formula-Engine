/**
 * Formula lifecycle: create, change, deactivate, rollback.
 *
 * Every operation appends a version; nothing is updated or deleted. Writes for
 * one logical formula serialise on `formula_locks` (never on a version row that
 * may not exist yet) and a stale `expectedVersion` yields 409 with the current
 * version, so two concurrent editors cannot silently overwrite each other.
 */
const { randomUUID } = require("crypto");
const { transaction } = require("../config/database");
const formulaRepository = require("../repositories/formula.repository");
const dependencyRepository = require("../repositories/dependency.repository");
const { acquireLocks, uuidKey, nameKey } = require("../repositories/lock.repository");
const { evaluate } = require("../execution/evaluator");
const { collectIdentifiers } = require("../utils/formula-text");
const { graph, cyclePath, impacts } = require("./dependency.service");
const { AppError, badRequest } = require("../utils/errors");
const { formula: serialize, historyEntry } = require("./serializers");

const MAX_FORMULA_LENGTH = 10000;

/** Parse-only validation; throws a 400 with the parser message. */
function assertSyntax(formulaText) {
  try {
    collectIdentifiers(formulaText);
  } catch (error) {
    throw new AppError(400, "FORMULA_SYNTAX", `Invalid formula: ${error.message}`, {
      formulaText,
    });
  }
}

/**
 * Execute the formula once against sample values for every identifier it
 * references. Catches references to unknown helpers and interpreter-level
 * syntax problems before a version is stored.
 */
async function assertExecutable(formulaText) {
  const names = collectIdentifiers(formulaText);
  const samples = {};
  for (const name of [...names.external, ...names.free]) samples[name] = 1;

  const result = await evaluate(formulaText, samples, { collectCalculation: false });
  if (!result.ok) {
    throw new AppError(400, "FORMULA_EVALUATION", `Formula cannot be evaluated: ${result.error}`, {
      formulaText,
    });
  }
}

/** In-memory dependency helpers over the current versions. */
const activeFormulas = async (executor) =>
  formulaRepository.list(executor, "ACTIVE");

const assertNoCycle = (formulas, candidate) => {
  const others = formulas.filter((item) => item.uuid !== candidate.uuid);
  const { deps } = graph([...others, candidate]);
  const cycle = cyclePath(deps);
  if (cycle) {
    throw new AppError(400, "CIRCULAR_DEPENDENCY", `Circular dependency: ${cycle.join(" -> ")}`, {
      cycle,
    });
  }
};

const assertNameAvailable = (formulas, candidate) => {
  const clash = formulas.find(
    (item) =>
      item.uuid !== candidate.uuid &&
      item.name.toLowerCase() === candidate.name.toLowerCase()
  );
  if (clash) {
    throw new AppError(409, "DUPLICATE_NAME", "An active formula already uses this name", {
      name: candidate.name,
      uuid: clash.uuid,
      version: Number(clash.version),
    });
  }
};

/** Referenced names that are formulas (edges to store for this version). */
const referencedFormulas = (formulaText, formulaName, formulas) => {
  const names = new Set(formulas.map((item) => item.name));
  return [...collectIdentifiers(formulaText).free].filter(
    (name) => names.has(name) && name !== formulaName
  );
};

async function create(input) {
  if (input.formulaText.length > MAX_FORMULA_LENGTH) {
    throw badRequest(`formulaText exceeds ${MAX_FORMULA_LENGTH} characters`);
  }
  assertSyntax(input.formulaText);
  await assertExecutable(input.formulaText);

  const uuid = input.uuid || randomUUID();

  const stored = await transaction(async (connection) => {
    await acquireLocks(connection, [
      uuidKey(uuid),
      input.name ? nameKey(input.name) : null,
    ]);

    const current = await formulaRepository.current(connection, uuid);
    if (current && input.expectedVersion === undefined) {
      throw badRequest("expectedVersion is required when changing a formula", {
        uuid,
        currentVersion: Number(current.version),
      });
    }
    if (!current && input.expectedVersion !== undefined) {
      throw new AppError(404, "NOT_FOUND", "Formula not found", { uuid });
    }

    const formulas = await activeFormulas(connection);
    assertNameAvailable(formulas, { uuid, name: input.name });

    if (current && current.name !== input.name) {
      const dependents = impacts(formulas, current.name);
      if (dependents.length) {
        throw new AppError(
          409,
          "DEPENDENCY_IMPACT",
          "Formula is referenced by other active formulas and cannot be renamed",
          { dependents }
        );
      }
    }

    assertNoCycle(formulas, {
      uuid,
      name: input.name,
      formula_text: input.formulaText,
    });

    const version = await formulaRepository.appendFormula(connection, {
      uuid,
      name: input.name,
      formulaText: input.formulaText,
      status: "ACTIVE",
      createdBy: input.createdBy,
      expectedVersion: input.expectedVersion,
    });

    const edges = referencedFormulas(input.formulaText, input.name, formulas);
    await dependencyRepository.insertEdges(connection, version, edges);

    return { ...version, edges };
  });

  return { ...serialize(stored), dependencies: stored.edges, previousVersion: stored.previousVersion ? Number(stored.previousVersion.version) : null };
}

async function changeStatus(uuid, input, status) {
  const stored = await transaction(async (connection) => {
    await acquireLocks(connection, [uuidKey(uuid)]);

    const current = await formulaRepository.current(connection, uuid);
    if (!current) throw new AppError(404, "NOT_FOUND", "Formula not found", { uuid });

    const formulas = await activeFormulas(connection);
    if (status === "INACTIVE") {
      const dependents = impacts(formulas, current.name);
      if (dependents.length && !input.force) {
        throw new AppError(
          409,
          "DEPENDENCY_IMPACT",
          "Formula is referenced by other active formulas; pass force=true to deactivate anyway",
          { dependents }
        );
      }
    }

    const version = await formulaRepository.appendFormula(connection, {
      uuid,
      status,
      createdBy: input.createdBy,
      expectedVersion: input.expectedVersion,
    });

    return { ...version, dependents: status === "INACTIVE" ? impacts(formulas, current.name) : [] };
  });

  return {
    ...serialize(stored),
    previousVersion: stored.previousVersion ? Number(stored.previousVersion.version) : null,
    ...(status === "INACTIVE" ? { dependentFormulas: stored.dependents } : {}),
  };
}

const deactivate = (uuid, input) => changeStatus(uuid, input, "INACTIVE");

async function rollback(uuid, input) {
  const stored = await transaction(async (connection) => {
    await acquireLocks(connection, [uuidKey(uuid)]);

    const current = await formulaRepository.current(connection, uuid);
    if (!current) throw new AppError(404, "NOT_FOUND", "Formula not found", { uuid });

    const [target] = input.id
      ? await connection.execute("SELECT * FROM formulas WHERE uuid = ? AND id = ?", [uuid, input.id])
      : await connection.execute("SELECT * FROM formulas WHERE uuid = ? AND version = ?", [
          uuid,
          input.version,
        ]);
    if (!target[0]) {
      throw new AppError(404, "NOT_FOUND", "Historical version not found", {
        uuid,
        ...(input.id ? { id: input.id } : { version: input.version }),
      });
    }

    const formulas = await activeFormulas(connection);
    const restored = target[0];

    if (restored.status === "ACTIVE") assertNameAvailable(formulas, { uuid, name: restored.name });
    assertNoCycle(formulas, {
      uuid,
      name: restored.name,
      formula_text: restored.formula_text,
    });

    const version = await formulaRepository.appendFormula(connection, {
      uuid,
      name: restored.name,
      formulaText: restored.formula_text,
      status: restored.status,
      createdBy: input.createdBy,
      expectedVersion: input.expectedVersion,
    });

    const edges = referencedFormulas(restored.formula_text, restored.name, formulas);
    await dependencyRepository.insertEdges(connection, version, edges);

    return { ...version, edges, restoredFrom: { version: Number(restored.version), id: Number(restored.id) } };
  });

  return {
    ...serialize(stored),
    dependencies: stored.edges,
    restoredFrom: stored.restoredFrom,
    previousVersion: stored.previousVersion ? Number(stored.previousVersion.version) : null,
  };
}

async function list(executor, { status } = {}) {
  const rows = await formulaRepository.list(executor, status);
  return rows.map(serialize);
}

async function history(executor, uuid) {
  const rows = await formulaRepository.history(executor, uuid);
  if (!rows.length) throw new AppError(404, "NOT_FOUND", "Formula not found", { uuid });
  return rows.map(historyEntry);
}

async function impact(executor, uuid) {
  const current = await formulaRepository.current(executor, uuid);
  if (!current) throw new AppError(404, "NOT_FOUND", "Formula not found", { uuid });
  const formulas = await activeFormulas(executor);
  const impacted = impacts(formulas, current.name);
  return {
    formula: serialize(current),
    impactedFormulas: impacted.map((name) => {
      const row = formulas.find((item) => item.name === name);
      return { uuid: row.uuid, name, version: Number(row.version) };
    }),
    impactedCount: impacted.length,
  };
}

module.exports = {
  create,
  deactivate,
  changeStatus,
  rollback,
  list,
  history,
  impact,
  assertSyntax,
};
