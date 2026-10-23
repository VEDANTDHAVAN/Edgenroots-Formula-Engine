class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) =>
  new AppError(400, "VALIDATION_ERROR", message, details);

const notFound = (message = "Resource not found", details) =>
  new AppError(404, "NOT_FOUND", message, details);

const conflict = (code, message, details) => new AppError(409, code, message, details);

const unprocessable = (code, message, details) =>
  new AppError(422, code, message, details);

const serviceUnavailable = (message, details) =>
  new AppError(503, "SERVICE_UNAVAILABLE", message, details);

module.exports = {
  AppError,
  badRequest,
  notFound,
  conflict,
  unprocessable,
  serviceUnavailable,
};
