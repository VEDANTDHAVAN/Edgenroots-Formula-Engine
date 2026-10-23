const { AppError } = require("../utils/errors");
const logger = require("../utils/logger");

/** MySQL error numbers with a stable HTTP meaning. */
const MYSQL_STATUS = {
  1062: { status: 409, code: "DUPLICATE_RECORD" },
  1213: { status: 409, code: "LOCK_DEADLOCK" },
  1205: { status: 503, code: "LOCK_TIMEOUT" },
  1040: { status: 503, code: "SERVICE_UNAVAILABLE" },
  1045: { status: 503, code: "SERVICE_UNAVAILABLE" },
  1146: { status: 503, code: "SCHEMA_MISSING" },
};

// eslint-disable-next-line no-unused-vars -- express identifies error middleware by arity
module.exports = (error, req, res, next) => {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Unexpected server error";
  let details;

  if (error instanceof AppError) {
    ({ status, code, message, details } = error);
  } else if (error && error.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Request body is not valid JSON";
  } else if (error && error.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Request body is too large";
  } else if (error && MYSQL_STATUS[error.errno]) {
    ({ status, code } = MYSQL_STATUS[error.errno]);
    message =
      error.errno === 1146
        ? "Database schema is not initialised; run npm run db:setup"
        : "Database rejected the write";
    logger.error("database error", { errno: error.errno, sqlMessage: error.sqlMessage });
  }

  if (status >= 500) {
    logger.error("request failed", {
      method: req.method,
      path: req.originalUrl,
      error: error && error.message,
      stack: error && error.stack,
    });
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
};
