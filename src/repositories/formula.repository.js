/**
 * Formula persistence. Append-only: this module only ever INSERTs business
 * rows and reads them back.
 */
const {
  saveRecord,
  appendVersion,
  findCurrent,
  findHistory,
  listCurrent,
} = require("./base.repository");

const TABLE = "formulas";
const CURRENT_VIEW = "current_formulas";
const COLUMNS = [
  "uuid",
  "name",
  "formula_text",
  "status",
  "created_by",
  "first_created_at",
  "version",
];

const list = (executor, status) => listCurrent(executor, CURRENT_VIEW, status);
const current = (executor, uuid) => findCurrent(executor, CURRENT_VIEW, uuid);
const history = (executor, uuid) => findHistory(executor, TABLE, uuid);

/**
 * Append the next version of a formula.
 *
 * @param {object} connection transaction connection holding the locks
 * @param {object} input      { uuid?, name, formulaText, status?, createdBy?, expectedVersion? }
 */
async function appendFormula(connection, input) {
  const row = {
    ...(input.uuid ? { uuid: input.uuid } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.formulaText !== undefined ? { formula_text: input.formulaText } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.createdBy !== undefined ? { created_by: input.createdBy } : {}),
    ...(input.firstCreatedAt !== undefined ? { first_created_at: input.firstCreatedAt } : {}),
  };

  const stored = await appendVersion(connection, TABLE, row, {
    currentView: CURRENT_VIEW,
    columns: COLUMNS,
    inheritedColumns: ["name", "formula_text", "status", "created_by", "first_created_at"],
    defaultValues: {
      status: "ACTIVE",
      created_by: "api",
      first_created_at: new Date(),
    },
    allowCreate: true,
    expectedVersion: input.expectedVersion,
    label: "Formula",
  });

  return stored;
}

module.exports = {
  TABLE,
  CURRENT_VIEW,
  COLUMNS,
  // generic helper, re-exported for tests and other append-only tables
  saveRecord,
  list,
  current,
  history,
  appendFormula,
};
