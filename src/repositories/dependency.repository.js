/**
 * Dependency edges per formula version (append-only).
 *
 * `formula_dependencies.depends_on_name` stores the referenced formula's name,
 * which is how formulas are addressed at run time. Inputs are not stored here;
 * they are whatever the caller did not resolve as a formula.
 */
const TABLE = "formula_dependencies";
const COLUMNS = [
  "formula_id",
  "formula_uuid",
  "formula_version",
  "formula_name",
  "depends_on_name",
  "created_at",
];

/**
 * @param {object} connection transaction connection
 * @param {{id:number, uuid:string, version:number, name:string}} formula inserted version
 * @param {string[]} dependsOn referenced formula names
 */
async function insertEdges(connection, formula, dependsOn) {
  const names = [...new Set(dependsOn)].filter((name) => name !== formula.name).sort();
  if (!names.length) return [];

  const placeholders = names.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const values = names.flatMap((name) => [
    formula.id,
    formula.uuid,
    formula.version,
    formula.name,
    name,
    new Date(),
  ]);

  await connection.execute(
    `INSERT INTO ${TABLE} (${COLUMNS.join(", ")}) VALUES ${placeholders}`,
    values
  );
  return names;
}

/** Edges of one stored version. */
async function forVersion(connection, uuid, version) {
  const [rows] = await connection.execute(
    `SELECT depends_on_name FROM ${TABLE} WHERE formula_uuid = ? AND formula_version = ? ORDER BY depends_on_name`,
    [uuid, version]
  );
  return rows.map((row) => row.depends_on_name);
}

/** Edges of the current versions of every active formula. */
async function activeEdges(executor) {
  const [rows] = await executor.execute(
    `SELECT d.formula_name AS dependent, d.depends_on_name AS dependency
       FROM ${TABLE} d
       JOIN current_formulas c ON c.id = d.formula_id
      WHERE c.status = 'ACTIVE'`
  );
  return rows;
}

module.exports = { TABLE, COLUMNS, insertEdges, forVersion, activeEdges };
