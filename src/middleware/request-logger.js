const logger = require("../utils/logger");

/** One structured access-log line per request (no bodies: they may hold data). */
module.exports = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info("request", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    });
  });
  next();
};
