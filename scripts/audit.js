#!/usr/bin/env node
/**
 * Run the seven reporting queries from sql/queries.sql and print their rows.
 *
 *   npm run audit
 *
 * Read-only: it opens the application connection from .env and executes the
 * statements in order. Useful to eyeball the reports after seeding data.
 */
const fs = require("fs");
const path = require("path");
const { pool, closePool } = require("../src/config/database");
const env = require("../src/config/env");

const QUERIES_PATH = path.join(__dirname, "..", "sql", "queries.sql");

const TITLES = [
  "1. version history",
  "2. active formulas in dependency order",
  "3. versions per formula",
  "4. runs / failures / failure % (7 days)",
  "5. five most-failing formulas with latest error",
  "6. deactivated and never reactivated",
  "7. interval between consecutive versions",
  "7b. average change interval (summary)",
];

/** Split the file into statements, dropping `--` comment lines. */
function loadQueries() {
  return fs
    .readFileSync(QUERIES_PATH, "utf8")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
}

function printRows(rows) {
  if (!rows.length) {
    process.stdout.write("  (no rows)\n");
    return;
  }
  const columns = Object.keys(rows[0]);
  const cells = rows.map((row) =>
    columns.map((column) => {
      const value = row[column];
      if (value === null || value === undefined) return "NULL";
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    })
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((line) => line[index].length))
  );
  const line = (values) =>
    values.map((value, index) => String(value).padEnd(widths[index])).join("  ");

  process.stdout.write(`  ${line(columns)}\n`);
  process.stdout.write(`  ${line(widths.map((width) => "-".repeat(width)))}\n`);
  for (const row of cells) process.stdout.write(`  ${line(row)}\n`);
}

async function main() {
  const queries = loadQueries();
  process.stdout.write(
    `[audit] ${queries.length} statements against ${env.db.database}@${env.db.host}:${env.db.port}\n`
  );

  for (let index = 0; index < queries.length; index++) {
    const title = TITLES[index] || `statement ${index + 1}`;
    const startedAt = process.hrtime.bigint();
    const [rows] = await pool.query(queries[index]);
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;

    process.stdout.write(
      `\n${title} — ${rows.length} row(s) in ${elapsed.toFixed(2)} ms\n`
    );
    printRows(rows);
  }
  process.stdout.write("\n");
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error) => {
    process.stderr.write(`[audit] failed: ${error.message}\n`);
    await closePool().catch(() => {});
    process.exit(1);
  });
