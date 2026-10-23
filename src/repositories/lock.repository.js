/**
 * Logical row locks for append-only writes.
 *
 * A formula version row cannot be locked before it exists, so writes serialise
 * on a stable key instead:
 *
 *   INSERT IGNORE INTO formula_locks (lock_key) VALUES ('uuid:<uuid>');  -- autocommit
 *   SELECT lock_key FROM formula_locks WHERE lock_key = ? FOR UPDATE;    -- in txn
 *
 * The insert runs on its own (autocommit) connection so the row exists before
 * any transaction touches it. Doing the insert inside the transaction would take
 * a shared lock that two writers then both try to upgrade to exclusive, which
 * MySQL reports as a deadlock. The `SELECT ... FOR UPDATE` is the actual mutex
 * and is released by COMMIT/ROLLBACK, so nothing can leak on a pooled connection
 * the way `GET_LOCK()` does.
 *
 * Keys are always acquired in sorted order, so two writers that need several
 * keys can never take them in opposite orders.
 */
const { pool } = require("../config/database");

const LOCK_TABLE = "formula_locks";
const MAX_KEY_LENGTH = 191;

const uuidKey = (uuid) => `uuid:${uuid}`;
const nameKey = (name) => `name:${name}`;

/** Create any missing lock rows outside the caller's transaction. */
async function ensureLockRows(keys) {
  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH) {
      throw new Error(`Lock key too long: ${key.slice(0, 40)}…`);
    }
    await pool.execute(`INSERT IGNORE INTO ${LOCK_TABLE} (lock_key) VALUES (?)`, [key]);
  }
}

/**
 * @param {object} connection transaction connection
 * @param {string[]} keys
 * @returns {Promise<string[]>} the keys now held, sorted
 */
async function acquireLocks(connection, keys) {
  const unique = [...new Set(keys.filter(Boolean))].sort();
  if (!unique.length) return [];

  await ensureLockRows(unique);

  for (const key of unique) {
    const [rows] = await connection.execute(
      `SELECT lock_key FROM ${LOCK_TABLE} WHERE lock_key = ? FOR UPDATE`,
      [key]
    );
    if (rows.length !== 1) {
      throw new Error(`Failed to acquire lock: ${key}`);
    }
  }
  return unique;
}

module.exports = { acquireLocks, ensureLockRows, uuidKey, nameKey, LOCK_TABLE };
