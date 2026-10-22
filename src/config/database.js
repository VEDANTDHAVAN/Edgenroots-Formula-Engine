const mysql = require("mysql2/promise");
const env = require("./env");
const pool = mysql.createPool({
  ...env.db,
  waitForConnections: true,
  namedPlaceholders: false,
  decimalNumbers: true,
});
module.exports = {
  pool,
  transaction: async (fn) => {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const value = await fn(c);
      await c.commit();
      return value;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  },
};
