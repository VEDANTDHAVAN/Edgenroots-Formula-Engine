/**
 * Run log persistence (append-only audit trail for every evaluated formula).
 */
const TABLE = "formula_run_logs";
const COLUMNS = [
  "run_uuid",
  "record_index",
  "formula_uuid",
  "formula_name",
  "formula_version",
  "input_values",
  "result",
  "calculation_text",
  "status",
  "error_message",
  "skip_reason",
  "duration_ms",
  "executed_at",
];

/** DECIMAL(38,10) column: keep numbers, never stringify them. */
const numericOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
};

const textOrNull = (value) =>
  value === null || value === undefined ? null : String(value);

/**
 * Normalise one API/service log entry to a table row.
 *
 * @param {object} log
 */
function toRow(log) {
  return {
    run_uuid: log.runUuid,
    record_index: log.recordIndex ?? 0,
    formula_uuid: log.formulaUuid,
    formula_name: log.formulaName,
    formula_version: log.formulaVersion,
    input_values: JSON.stringify(log.input ?? {}),
    result: numericOrNull(log.result),
    calculation_text: textOrNull(log.calculation),
    status: log.status,
    error_message: textOrNull(log.error),
    skip_reason: textOrNull(log.skipReason),
    duration_ms: Math.max(0, Math.round(log.durationMs ?? 0)),
    executed_at: log.executedAt ? new Date(log.executedAt) : new Date(),
  };
}

/**
 * Insert many rows in chunked multi-row statements (keeps each statement well
 * below MySQL's max_allowed_packet and placeholder limits).
 *
 * @param {object} executor pool or transaction connection
 * @param {object[]} logs
 * @param {number} [chunkSize]
 */
async function insertMany(executor, logs, chunkSize = 200) {
  if (!logs || !logs.length) return { inserted: 0 };

  const rows = logs.map(toRow);
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const sql =
      `INSERT INTO ${TABLE} (${COLUMNS.join(", ")}) VALUES ` +
      chunk.map(() => `(${COLUMNS.map(() => "?").join(", ")})`).join(", ");
    const [result] = await executor.execute(
      sql,
      chunk.flatMap((row) => COLUMNS.map((column) => row[column]))
    );
    inserted += result.affectedRows;
  }

  return { inserted };
}

/** Logs of one run, in record order. */
async function forRun(executor, runUuid) {
  const [rows] = await executor.execute(
    `SELECT * FROM ${TABLE} WHERE run_uuid = ? ORDER BY record_index, id`,
    [runUuid]
  );
  return rows;
}

module.exports = { TABLE, COLUMNS, toRow, insertMany, forRun };
