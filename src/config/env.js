require("dotenv").config();

const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
};

const oneOf = (name, allowed, fallback) => {
  const value = (process.env[name] || fallback).toLowerCase();
  if (!allowed.includes(value))
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
};

const optional = (name, fallback = "") => process.env[name] ?? fallback;

module.exports = Object.freeze({
  port: integer("PORT", 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  logLevel: oneOf("LOG_LEVEL", ["debug", "info", "warn", "error", "silent"], "info"),
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: integer("DB_PORT", 3306),
    database: process.env.DB_NAME || "edgenroots",
    user: process.env.DB_USER || "edgenroots",
    password: optional("DB_PASSWORD"),
    connectionLimit: integer("DB_POOL_SIZE", 10),
  },
  dbAdmin: {
    user: process.env.DB_ADMIN_USER || "root",
    password: optional("DB_ADMIN_PASSWORD"),
  },
  evaluation: {
    // "pool"        - supervised persistent workers running formula-interpreter's
    //                 own evaluator module (default; required for the 500 x 10 target)
    // "interpretor" - one public `interpretor()` call per evaluation
    mode: oneOf("EVALUATION_MODE", ["pool", "interpretor"], "pool"),
    workers: integer("EVALUATION_WORKERS", 4),
    concurrency: integer("EVALUATION_CONCURRENCY", 4),
    timeoutMs: integer("EVALUATION_TIMEOUT_MS", 2000),
    memoryMb: integer("EVALUATION_MEMORY_MB", 128),
    recycleAfter: integer("EVALUATION_RECYCLE_AFTER", 500),
  },
  bodyLimit: process.env.MAX_JSON_BODY_BYTES || "1mb",
});
