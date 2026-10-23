const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const env = require("./config/env");
const logger = require("./utils/logger");
const requestLogger = require("./middleware/request-logger");
const errorHandler = require("./middleware/error-handler");
const { AppError } = require("./utils/errors");

const app = express();

// The engine is an internal service: sensible security defaults, explicit CORS.
app.disable("x-powered-by");
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: env.bodyLimit }));
app.use(requestLogger);

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptimeSeconds: Number(process.uptime().toFixed(2)) });
});

app.use("/formulas", require("./routes/formula.routes"));

app.use((req, res, next) => {
  next(new AppError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));
});

app.use(errorHandler);

module.exports = app;
