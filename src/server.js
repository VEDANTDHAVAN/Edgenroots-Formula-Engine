const http = require("http");
const app = require("./app");
const env = require("./config/env");
const logger = require("./utils/logger");
const { ping, closePool } = require("./config/database");
const { shutdown: shutdownEvaluator } = require("./execution/evaluator");

const server = http.createServer(app);

async function start() {
  try {
    const ok = await ping();
    logger.info("database connection verified", { ok });
  } catch (error) {
    logger.error("database is not reachable", {
      error: error.message,
      hint: "run `npm run db:setup` after starting MySQL",
    });
  }

  server.listen(env.port, () => {
    logger.info("formula engine listening", {
      port: env.port,
      evaluationMode: env.evaluation.mode,
      workers: env.evaluation.workers,
    });
  });
}

let shuttingDown = false;

async function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });

  await new Promise((resolve) => server.close(resolve));
  await shutdownEvaluator().catch((error) =>
    logger.error("evaluator shutdown failed", { error: error.message })
  );
  await closePool().catch((error) =>
    logger.error("database shutdown failed", { error: error.message })
  );
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

start();
