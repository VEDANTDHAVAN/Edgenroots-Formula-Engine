/**
 * Database helpers for integration tests.
 *
 * The application never deletes business rows; tests must start from a known
 * state, so this helper truncates the tables directly. It is test-only and is
 * never imported by `src/`.
 */
const { pool, closePool } = require("../../src/config/database");

const TABLES = ["formula_run_logs", "formula_dependencies", "formulas", "formula_locks"];

async function resetDatabase() {
  await pool.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const table of TABLES) {
    await pool.query(`TRUNCATE TABLE \`${table}\``);
  }
  await pool.query("SET FOREIGN_KEY_CHECKS = 1");
}

async function countRows(table) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
  return Number(rows[0].total);
}

async function closeDatabase() {
  await closePool();
}

module.exports = { resetDatabase, countRows, closeDatabase, pool };
