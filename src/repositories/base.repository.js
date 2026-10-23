/**
 * Generic, append-only persistence helpers.
 *
 * `saveRecord(executor, table, data, options)` is intentionally table-agnostic:
 * it validates every identifier, builds ONE multi-row INSERT for a single row or
 * an array, and returns the inserted ids plus the UUID of each row.
 *
 * Versioning is layered on top by `appendVersion()`:
 *   * the current row is read from a "current version" view,
 *   * the new version is current.version + 1,
 *   * the caller-supplied `expectedVersion` is checked while holding the row
 *     lock (see lock.repository.js), so a stale writer gets a 409,
 *   * unchanged columns are inherited from the current row.
 *
 * Business rows are never UPDATEd or DELETEd by this module.
 */
const { randomUUID } = require("crypto");
const { assertIdentifier } = require("../utils/identifiers");
const { AppError } = require("../utils/errors");

const quote = (identifier) => `\`${assertIdentifier(identifier, "identifier")}\``;

/**
 * Insert one or many rows with a single statement.
 *
 * @param {object} executor      pool or transaction connection
 * @param {string} table         target table (validated)
 * @param {object|object[]} data rows to insert
 * @param {object} options
 * @param {string} options.uuidColumn        name of the stable-identity column
 * @param {string[]} options.columns         allow-list of insertable columns
 * @param {string[]} [options.generatedColumns] read back after insert (defaults to id)
 * @param {string[]} [options.immutableColumns] never taken from the request data
 * @param {string} [options.returning]       column to return per row
 * @returns {Promise<Array<object>>} rows with their generated id (and UUID)
 */
async function saveRecord(executor, table, data, options = {}) {
  const {
    uuidColumn = "uuid",
    columns,
    immutableColumns = [],
    generatedColumns = ["id"],
  } = options;

  assertIdentifier(table, "table");
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`saveRecord(${table}): options.columns is required`);
  }
  columns.forEach((column) => assertIdentifier(column, "column"));
  immutableColumns.forEach((column) => assertIdentifier(column, "immutable column"));
  generatedColumns.forEach((column) => assertIdentifier(column, "generated column"));

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return [];

  const allowed = new Set([...columns, ...immutableColumns]);
  const prepared = rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new AppError(400, "VALIDATION_ERROR", `Row ${index} is not an object`);
    }
    const unknown = Object.keys(row).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new AppError(400, "VALIDATION_ERROR", "Unknown columns", {
        table,
        columns: unknown,
      });
    }
    for (const column of immutableColumns) {
      if (column in row) {
        throw new AppError(400, "VALIDATION_ERROR", `Column is immutable: ${column}`);
      }
    }
    const values = columns.map((column) => (column in row ? row[column] : null));
    const uuid = values[columns.indexOf(uuidColumn)];
    if (columns.includes(uuidColumn) && !uuid) {
      throw new AppError(400, "VALIDATION_ERROR", `${uuidColumn} is required`);
    }
    return { uuid, values };
  });

  const sql =
    `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES ` +
    prepared.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");

  const [result] = await executor.execute(sql, prepared.flatMap((row) => row.values));

  if (prepared.length > 1 && result.affectedRows !== prepared.length) {
    throw new Error(
      `saveRecord(${table}): inserted ${result.affectedRows} of ${prepared.length} rows`
    );
  }

  const inserted = prepared.map((row, index) => ({
    id: result.insertId + index,
    [uuidColumn]: row.uuid,
  }));

  // Read back server-generated defaults (timestamps) in one statement.
  if (generatedColumns.length) {
    const [stored] = await executor.execute(
      `SELECT ${generatedColumns.map(quote).join(", ")} FROM ${quote(table)} WHERE id IN (${inserted
        .map(() => "?")
        .join(", ")}) ORDER BY id`,
      inserted.map((row) => row.id)
    );
    stored.forEach((row, index) => Object.assign(inserted[index], row));
  }

  return inserted;
}

/**
 * Append a new version of a logical record.
 *
 * @param {object} connection    transaction connection (locks already held)
 * @param {string} table
 * @param {object} input         request data; unknown keys are rejected
 * @param {object} options
 * @param {string} options.currentView       view selecting the max-id row per UUID
 * @param {string[]} options.columns         insertable columns
 * @param {string[]} [options.inheritedColumns] taken from the current row, not the input
 * @param {string[]} [options.defaults]      literal defaults for a brand-new record
 * @param {object} [options.defaultValues]   { column: value } defaults
 * @param {string} [options.uuidColumn]
 * @param {number} [options.expectedVersion]
 * @param {boolean} [options.allowCreate]    when false a missing record is 404
 */
async function appendVersion(connection, table, input, options = {}) {
  const {
    currentView,
    columns,
    inheritedColumns = [],
    defaultValues = {},
    uuidColumn = "uuid",
    expectedVersion,
    allowCreate = true,
    label = "Record",
  } = options;

  assertIdentifier(currentView, "view");
  const uuid = input[uuidColumn] || randomUUID();
  const current = await findCurrent(connection, currentView, uuid, uuidColumn);

  if (!current && !allowCreate) {
    throw new AppError(404, "NOT_FOUND", `${label} not found`);
  }
  if (!current && expectedVersion) {
    throw new AppError(404, "NOT_FOUND", `${label} not found`, { [uuidColumn]: uuid });
  }

  const currentVersion = current ? Number(current.version) : 0;
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== currentVersion) {
    throw new AppError(409, "VERSION_CONFLICT", "Stale version", {
      expectedVersion,
      currentVersion,
      [uuidColumn]: uuid,
    });
  }

  const inherited = {};
  for (const column of inheritedColumns) {
    if (current && current[column] !== undefined) inherited[column] = current[column];
  }

  const row = {
    ...defaultValues,
    ...inherited,
    ...input,
    [uuidColumn]: uuid,
    version: currentVersion + 1,
  };

  for (const column of columns) {
    if (!(column in row)) row[column] = null;
  }

  const [inserted] = await saveRecord(connection, table, row, {
    uuidColumn,
    columns,
    generatedColumns: ["id", "inserted_at"],
  });

  return { ...row, ...inserted, previousVersion: current || null };
}

/**
 * Current version of one record. Keeps the append-only storage detail
 * ("greatest id per UUID") in a single place.
 */
async function findCurrent(executor, currentView, uuid, uuidColumn = "uuid") {
  assertIdentifier(currentView, "view");
  assertIdentifier(uuidColumn, "column");
  const [rows] = await executor.execute(
    `SELECT * FROM ${quote(currentView)} WHERE ${quote(uuidColumn)} = ? LIMIT 1`,
    [uuid]
  );
  return rows[0] || null;
}

/** Every stored version of one record, oldest first. */
async function findHistory(executor, table, uuid, uuidColumn = "uuid") {
  assertIdentifier(table, "table");
  assertIdentifier(uuidColumn, "column");
  const [rows] = await executor.execute(
    `SELECT * FROM ${quote(table)} WHERE ${quote(uuidColumn)} = ? ORDER BY id`,
    [uuid]
  );
  return rows;
}

/** Current versions of every record, optionally filtered by status. */
async function listCurrent(executor, currentView, status) {
  assertIdentifier(currentView, "view");
  if (status) assertIdentifier(status, "status");
  const [rows] = status
    ? await executor.execute(
        `SELECT * FROM ${quote(currentView)} WHERE status = ? ORDER BY name, id`,
        [status]
      )
    : await executor.execute(`SELECT * FROM ${quote(currentView)} ORDER BY name, id`);
  return rows;
}

module.exports = {
  saveRecord,
  appendVersion,
  findCurrent,
  findHistory,
  listCurrent,
};
