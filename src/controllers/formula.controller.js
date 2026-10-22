const svc = require("../services/formula.service");
const { pool } = require("../config/database");
const { preview } = require("../services/preview.service");
const { impacts } = require("../services/dependency.service");
const { AppError } = require("../utils/errors");
const parse = (schema, value) => {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Invalid request",
      r.error.issues,
    );
  return r.data;
};
exports.create = async (req, res, next) => {
  try {
    res
      .status(201)
      .json({
        data: await svc.create(
          parse(require("../validators/formula.validators").create, req.body),
        ),
      });
  } catch (e) {
    next(e);
  }
};
exports.deactivate = async (req, res, next) => {
  try {
    res.json({
      data: await svc.changeStatus(
        req.params.uuid,
        parse(require("../validators/formula.validators").action, req.body),
        "INACTIVE",
      ),
    });
  } catch (e) {
    next(e);
  }
};
exports.rollback = async (req, res, next) => {
  try {
    res.json({
      data: await svc.rollback(
        req.params.uuid,
        parse(require("../validators/formula.validators").rollback, req.body),
      ),
    });
  } catch (e) {
    next(e);
  }
};
exports.list = async (req, res, next) => {
  try {
    const [r] = await pool.execute(
      "SELECT * FROM current_formulas ORDER BY name",
    );
    res.json({ data: r });
  } catch (e) {
    next(e);
  }
};
exports.history = async (req, res, next) => {
  try {
    const [r] = await pool.execute(
      "SELECT * FROM formulas WHERE uuid=? ORDER BY id",
      [req.params.uuid],
    );
    res.json({ data: r });
  } catch (e) {
    next(e);
  }
};
exports.impact = async (req, res, next) => {
  try {
    const [r] = await pool.execute(
      "SELECT * FROM current_formulas WHERE status='ACTIVE'",
    );
    const f = r.find((x) => x.uuid === req.params.uuid);
    if (!f)
      return res
        .status(404)
        .json({ error: { code: "NOT_FOUND", message: "Formula not found" } });
    res.json({ data: impacts(r, f.name) });
  } catch (e) {
    next(e);
  }
};
exports.preview = async (req, res, next) => {
  try {
    res.json({
      data: await preview(
        parse(require("../validators/preview.validators").preview, req.body)
          .input,
        req.body,
      ),
    });
  } catch (e) {
    next(e);
  }
};
exports.bulk = async (req, res, next) => {
  try {
    const body = parse(
        require("../validators/preview.validators").bulk,
        req.body,
      ),
      started = Date.now();
    const results = [];
    for (const input of body.records) results.push(await preview(input, body));
    res.json({
      data: {
        results,
        totalExecutionMs: Date.now() - started,
        averageMs: (Date.now() - started) / body.records.length,
      },
    });
  } catch (e) {
    next(e);
  }
};
