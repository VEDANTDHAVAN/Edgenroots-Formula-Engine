require("dotenv").config();
const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
};
module.exports = Object.freeze({
  port: integer("PORT", 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: integer("DB_PORT", 3306),
    database: process.env.DB_NAME || "edgenroots",
    user: process.env.DB_USER || "edgenroots",
    password: process.env.DB_PASSWORD || "",
    connectionLimit: integer("DB_POOL_SIZE", 10),
  },
  evaluationTimeoutMs: integer("EVALUATION_TIMEOUT_MS", 2000),
  evaluationConcurrency: integer("EVALUATION_CONCURRENCY", 4),
  bodyLimit: process.env.MAX_JSON_BODY_BYTES || "1mb",
});
