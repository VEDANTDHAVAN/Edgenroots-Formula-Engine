/**
 * Read models over the append-only `formulas` table.
 *
 * `current_formulas` (the aggregate MAX(id) view) serves the live application.
 * The as-of read model cannot use a view because the timestamp is a parameter,
 * so it inlines the equivalent ROW_NUMBER() ranking.
 */
const CURRENT_VIEW = "current_formulas";
const WINDOW_VIEW = "current_formulas_window";

const AS_OF_SQL = `
  SELECT ranked.*
  FROM (
    SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.uuid ORDER BY f.id DESC) AS rn
    FROM formulas f
    WHERE f.inserted_at <= ?
  ) ranked
  WHERE ranked.rn = 1
`;

/** Active formulas as of `asOf` (Date); if omitted, the live current view. */
async function activeFormulas(executor, asOf) {
  if (!asOf) {
    const [rows] = await executor.execute(
      `SELECT * FROM ${CURRENT_VIEW} WHERE status = 'ACTIVE' ORDER BY name`
    );
    return rows;
  }
  const [rows] = await executor.execute(
    `SELECT * FROM (${AS_OF_SQL}) x WHERE x.status = 'ACTIVE' ORDER BY x.name`,
    [asOf]
  );
  return rows;
}

/** Current versions via the window-function view (parity/debug endpoint). */
async function currentWindow(executor) {
  const [rows] = await executor.execute(`SELECT * FROM ${WINDOW_VIEW} ORDER BY name`);
  return rows;
}

module.exports = { CURRENT_VIEW, WINDOW_VIEW, activeFormulas, currentWindow };
