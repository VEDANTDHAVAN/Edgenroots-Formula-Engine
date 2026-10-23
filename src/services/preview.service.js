/**
 * Preview / as-of / bulk evaluation.
 *
 * Runs the selected ACTIVE formulas in dependency order (one level at a time,
 * up to EVALUATION_CONCURRENCY in parallel), feeds each result back into the
 * shared input map so dependants see it, and writes one run-log row per
 * (record, formula) — success, failure and skip alike.
 */
const { randomUUID } = require("crypto");
const { pool } = require("../config/database");
const env = require("../config/env");
const { evaluate } = require("../execution/evaluator");
const { order, graph } = require("./dependency.service");
const { activeFormulas } = require("../repositories/formula-view.repository");
const runLogRepository = require("../repositories/run-log.repository");
const { AppError } = require("../utils/errors");

/** Run `tasks` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const selectFormulas = (formulas, formulaUuids) => {
  if (!formulaUuids || !formulaUuids.length) return formulas;
  const wanted = new Set(formulaUuids);
  const selected = formulas.filter((formula) => wanted.has(formula.uuid));
  const unknown = formulaUuids.filter(
    (uuid) => !formulas.some((formula) => formula.uuid === uuid)
  );
  if (unknown.length) {
    throw new AppError(404, "NOT_FOUND", "Unknown or inactive formula uuid", { unknown });
  }
  return selected;
};

/**
 * Evaluate one record.
 *
 * @param {object} input        caller-supplied values
 * @param {object} options      { formulaUuids?, asOf? }
 * @param {object} context      { runUuid, recordIndex, executor }
 */
async function runOne(input, { formulaUuids, asOf } = {}, context) {
  const { runUuid, recordIndex = 0, executor = pool } = context;

  const all = await activeFormulas(executor, asOf);
  const selected = selectFormulas(all, formulaUuids);
  const byName = new Map(selected.map((formula) => [formula.name, formula]));
  const { deps, missing } = graph(selected, { inputs: Object.keys(input) });

  const outputs = { ...input };
  const results = [];
  const logs = [];
  const startedAt = Date.now();

  const levels = order(selected);

  for (const level of levels) {
    const names = level.filter((name) => byName.has(name));
    const evaluated = await mapLimit(names, env.evaluation.concurrency, async (name) => {
      const formula = byName.get(name);
      const formulaStartedAt = Date.now();
      const inputs = { ...outputs };

      const blockedBy = (deps.get(name) || []).find((dependency) => {
        const dependencyResult = results.find((row) => row.name === dependency);
        return dependencyResult && dependencyResult.status !== "SUCCESS";
      });

      if (blockedBy) {
        return {
          formula,
          inputs,
          status: "SKIPPED",
          error: null,
          skipReason: `Dependency ${blockedBy} did not succeed`,
          calculation: null,
          result: null,
          durationMs: Date.now() - formulaStartedAt,
        };
      }

      const evaluation = await evaluate(formula.formula_text, inputs, {
        formulaNames: [...byName.keys()],
      });

      return {
        formula,
        inputs,
        status: evaluation.ok ? "SUCCESS" : "FAILED",
        result: evaluation.ok ? evaluation.result : null,
        calculation: evaluation.calculation,
        error: evaluation.ok ? null : evaluation.error,
        missingInputs: evaluation.missingInputs,
        timedOut: evaluation.timedOut,
        durationMs: evaluation.durationMs,
      };
    });

    for (const outcome of evaluated) {
      const { formula } = outcome;
      if (outcome.status === "SUCCESS") outputs[formula.name] = outcome.result;

      results.push({
        formulaUuid: formula.uuid,
        name: formula.name,
        version: Number(formula.version),
        formulaText: formula.formula_text,
        inputs: outcome.inputs,
        status: outcome.status,
        result: outcome.result,
        calculation: outcome.calculation,
        error: outcome.error,
        skipReason: outcome.skipReason ?? null,
        missingInputs: outcome.missingInputs || [],
        timedOut: Boolean(outcome.timedOut),
        durationMs: Math.round(outcome.durationMs),
        unresolvedIdentifiers: missing.get(formula.name) || [],
      });

      logs.push({
        runUuid,
        recordIndex,
        formulaUuid: formula.uuid,
        formulaName: formula.name,
        formulaVersion: Number(formula.version),
        input: outcome.inputs,
        result: outcome.result,
        calculation: outcome.calculation,
        status: outcome.status,
        error: outcome.error,
        skipReason: outcome.skipReason,
        durationMs: outcome.durationMs,
      });
    }
  }

  const stats = summarize(results, Date.now() - startedAt);
  return { runUuid, recordIndex, formulas: results, output: outputs, stats, logs };
}

function summarize(results, durationMs) {
  const succeeded = results.filter((row) => row.status === "SUCCESS").length;
  const failed = results.filter((row) => row.status === "FAILED").length;
  const skipped = results.filter((row) => row.status === "SKIPPED").length;
  return {
    evaluated: results.length,
    succeeded,
    failed,
    skipped,
    successRate: results.length ? Number(((succeeded / results.length) * 100).toFixed(2)) : 0,
    durationMs,
    averageMs: results.length ? Number((durationMs / results.length).toFixed(2)) : 0,
  };
}

async function preview(input, options = {}, { executor = pool } = {}) {
  const runUuid = randomUUID();
  const result = await runOne(input, options, { runUuid, recordIndex: 0, executor });
  await runLogRepository.insertMany(executor, result.logs);

  return {
    runUuid,
    asOf: options.asOf ? new Date(options.asOf).toISOString() : null,
    formulas: result.formulas,
    output: result.output,
    stats: result.stats,
  };
}

/**
 * Bulk preview: one shared runUuid, each record numbered and logged.
 * Bounded by the validator to 500 records per request.
 */
async function bulkPreview(records, options = {}, { executor = pool } = {}) {
  const runUuid = randomUUID();
  const startedAt = Date.now();
  const results = [];
  const logs = [];

  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const result = await runOne(records[recordIndex], options, {
      runUuid,
      recordIndex,
      executor,
    });
    results.push({
      recordIndex,
      input: records[recordIndex],
      output: result.output,
      formulas: result.formulas,
      stats: result.stats,
    });
    logs.push(...result.logs);
  }

  await runLogRepository.insertMany(executor, logs);

  const totalExecutionMs = Date.now() - startedAt;
  const totals = results.reduce(
    (sum, item) => ({
      evaluated: sum.evaluated + item.stats.evaluated,
      succeeded: sum.succeeded + item.stats.succeeded,
      failed: sum.failed + item.stats.failed,
      skipped: sum.skipped + item.stats.skipped,
    }),
    { evaluated: 0, succeeded: 0, failed: 0, skipped: 0 }
  );

  return {
    runUuid,
    asOf: options.asOf ? new Date(options.asOf).toISOString() : null,
    recordCount: records.length,
    results,
    stats: {
      ...totals,
      totalExecutionMs,
      averageMsPerRecord: Number((totalExecutionMs / records.length).toFixed(2)),
      averageMsPerFormula: totals.evaluated
        ? Number((totalExecutionMs / totals.evaluated).toFixed(2))
        : 0,
    },
  };
}

module.exports = { preview, bulkPreview, summarize, mapLimit };
