const { z } = require("zod");
const { AppError } = require("../utils/errors");

/** Validate `value` against a zod schema, turning issues into a 400. */
function parse(schema, value, label = "body") {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, "VALIDATION_ERROR", `Invalid ${label}`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join(".") || label,
        message: issue.message,
        code: issue.code,
      })),
    });
  }
  return result.data;
}

/** Wrap an express handler so rejected promises reach the error middleware. */
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const uuidParam = z.string().uuid();

module.exports = { parse, asyncHandler, uuidParam };
