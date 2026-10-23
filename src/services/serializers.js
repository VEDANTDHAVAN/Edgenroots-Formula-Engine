/** API serialisation - one shape for every endpoint. */
const formula = (row) =>
  row && {
    uuid: row.uuid,
    name: row.name,
    formulaText: row.formula_text,
    status: row.status,
    createdBy: row.created_by,
    version: Number(row.version),
    firstCreatedAt: row.first_created_at,
    insertedAt: row.inserted_at,
  };

const formulas = (rows) => rows.map(formula);

const historyEntry = (row) => ({
  id: Number(row.id),
  ...formula(row),
});

module.exports = { formula, formulas, historyEntry };
