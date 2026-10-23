#!/usr/bin/env node
/**
 * Create the database, the application user and the schema.
 *
 *   npm run db:setup          create if missing (idempotent)
 *   npm run db:reset          DROP the databases first, then recreate
 *
 * Uses the *admin* credentials from .env (DB_ADMIN_USER / DB_ADMIN_PASSWORD);
 * the application user only ever gets privileges on its own schema.
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { escape } = require("mysql2");
const env = require("../src/config/env");

const SCHEMA_PATH = path.join(__dirname, "..", "sql", "schema.sql");
const DATABASES = [env.db.database, `${env.db.database}_test`];

const log = (message) => process.stdout.write(`[db-setup] ${message}\n`);

/** Remove `--` comments and split on statement terminators. */
function statements(sql) {
  return sql
    .split("\n")
    .map((line) => (line.trim().startsWith("--") ? "" : line))
    .join("\n")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function main() {
  const reset = process.argv.includes("--reset");
  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  const schemaStatements = statements(schemaSql);

  const admin = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.dbAdmin.user,
    password: env.dbAdmin.password,
    multipleStatements: false,
  });

  try {
    const [[{ version }]] = await admin.query("SELECT VERSION() AS version");
    log(`connected as ${env.dbAdmin.user} to MySQL ${version}`);

    if (reset) {
      for (const database of DATABASES) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        log(`dropped ${database}`);
      }
    }

    for (const database of DATABASES) {
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
      );
      log(`database ready: ${database}`);
    }

    // `localhost` and `127.0.0.1` are distinct grants in MySQL; create both so
    // the service works whether the host is resolved or not.
    for (const host of ["localhost", "127.0.0.1"]) {
      await admin.query(
        `CREATE USER IF NOT EXISTS ${escape(env.db.user)}@${escape(host)} IDENTIFIED BY ${escape(env.db.password)}`
      );
      await admin.query(
        `ALTER USER ${escape(env.db.user)}@${escape(host)} IDENTIFIED BY ${escape(env.db.password)}`
      );
      const grants = DATABASES.map(
        (database) =>
          `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW ON \`${database}\`.* TO ${escape(env.db.user)}@${escape(host)}`
      );
      for (const grant of grants) await admin.query(grant);
      log(`user granted: ${env.db.user}@${host}`);
    }
  } finally {
    await admin.end();
  }

  // Apply the schema as the application user: proves the grants are sufficient.
  // The `_test` database gets the same schema so integration tests never touch
  // development data.
  for (const database of DATABASES) {
    const app = await mysql.createConnection({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database,
      multipleStatements: false,
    });

    try {
      for (const statement of schemaStatements) {
        await app.query(statement);
      }
      log(`applied ${schemaStatements.length} schema statements to ${database}`);

      const [tables] = await app.query("SHOW FULL TABLES");
      const [views] = await app.query(
        "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?",
        [database]
      );
      log(`  tables: ${tables.map((row) => Object.values(row)[0]).join(", ")}`);
      log(`  views: ${views.map((row) => row.TABLE_NAME).join(", ")}`);
    } finally {
      await app.end();
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[db-setup] failed: ${error.message}\n`);
  process.exit(1);
});
