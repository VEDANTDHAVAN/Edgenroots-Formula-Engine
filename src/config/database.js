const mysql = require("mysql2/promise");
const env = require("./env");
const logger = require("../utils/logger");

// timezone: "Z" keeps DATETIME(6) values in UTC on the way in and out, so
// `inserted_at`, as-of comparisons and MySQL's UTC_TIMESTAMP() all agree.
const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  connectionLimit: env.db.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  timezone: "Z",
  decimalNumbers: true,
  supportBigNumbers: true,
  charset: "utf8mb4",
});

const RETRYABLE = new Set([
  1213, // ER_LOCK_DEADLOCK
  1205, // ER_LOCK_WAIT_TIMEOUT
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn(connection)` inside a transaction.
 *
 * Deadlocks and lock-wait timeouts are retried a small number of times; the
 * callback must therefore be safe to re-run (no external side effects before
 * the final commit).
 */
async function transaction(fn, { retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const value = await fn(connection);
      await connection.commit();
      return value;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        logger.error("transaction rollback failed", { error: rollbackError.message });
      }
      if (RETRYABLE.has(error.errno) && attempt < retries) {
        logger.warn("retrying transaction after lock contention", {
          errno: error.errno,
          attempt,
        });
        await sleep(20 * attempt);
        continue;
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function closePool() {
  await pool.end();
}

async function ping() {
  const [rows] = await pool.query("SELECT 1 AS ok");
  return rows[0].ok === 1;
}

module.exports = { pool, transaction, closePool, ping };
