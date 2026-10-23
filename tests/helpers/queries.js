/**
 * Split sql/queries.sql into individual statements.
 *
 * The file is a sequence of `--` comment blocks followed by one statement each,
 * so a semicolon at the end of a line is a reliable separator here.
 */
const fs = require("fs");
const path = require("path");

const QUERIES_PATH = path.join(__dirname, "..", "..", "sql", "queries.sql");

function loadQueries() {
  const sql = fs.readFileSync(QUERIES_PATH, "utf8");
  return sql
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

module.exports = { loadQueries, QUERIES_PATH };
