const formulaService = require("../services/formula.service");
const previewService = require("../services/preview.service");
const { pool } = require("../config/database");
const { parse, asyncHandler, uuidParam } = require("../middleware/validate");
const validators = require("../validators/formula.validators");
const previewValidators = require("../validators/preview.validators");

const before = () => process.hrtime.bigint();
const elapsedMs = (startedAt) => Number(process.hrtime.bigint() - startedAt) / 1e6;

/** POST /formulas - create (or append a new version of) a formula. */
exports.create = asyncHandler(async (req, res) => {
  const body = parse(validators.create, req.body);
  res.status(201).json({ data: await formulaService.create(body) });
});

/** GET /formulas - current version of every formula. */
exports.list = asyncHandler(async (req, res) => {
  const query = parse(validators.listQuery, req.query, "query");
  res.json({ data: await formulaService.list(pool, query) });
});

/** GET /formulas/:uuid/history - every stored version, oldest first. */
exports.history = asyncHandler(async (req, res) => {
  const uuid = parse(uuidParam, req.params.uuid, "uuid");
  res.json({ data: await formulaService.history(pool, uuid) });
});

/** GET /formulas/:uuid/impact - formulas whose value depends on this one. */
exports.impact = asyncHandler(async (req, res) => {
  const uuid = parse(uuidParam, req.params.uuid, "uuid");
  res.json({ data: await formulaService.impact(pool, uuid) });
});

/** POST /formulas/:uuid/deactivate - append an INACTIVE version. */
exports.deactivate = asyncHandler(async (req, res) => {
  const uuid = parse(uuidParam, req.params.uuid, "uuid");
  const body = parse(validators.action, req.body);
  res.json({ data: await formulaService.deactivate(uuid, body) });
});

/** POST /formulas/:uuid/rollback - re-append a historical version. */
exports.rollback = asyncHandler(async (req, res) => {
  const uuid = parse(uuidParam, req.params.uuid, "uuid");
  const body = parse(validators.rollback, req.body);
  res.json({ data: await formulaService.rollback(uuid, body) });
});

/** POST /formulas/preview - evaluate one record. */
exports.preview = asyncHandler(async (req, res) => {
  const startedAt = before();
  const body = parse(previewValidators.preview, req.body);
  const data = await previewService.preview(body.input, {
    formulaUuids: body.formulaUuids,
    asOf: body.asOf,
  });
  res.json({ data: { ...data, requestDurationMs: Number(elapsedMs(startedAt).toFixed(2)) } });
});

/** POST /formulas/preview/bulk - evaluate up to 500 records in one run. */
exports.bulk = asyncHandler(async (req, res) => {
  const startedAt = before();
  const body = parse(previewValidators.bulk, req.body);
  const data = await previewService.bulkPreview(body.records, {
    formulaUuids: body.formulaUuids,
    asOf: body.asOf,
  });
  res.json({ data: { ...data, requestDurationMs: Number(elapsedMs(startedAt).toFixed(2)) } });
});
