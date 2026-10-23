/**
 * Evaluator adapter - the single place formulas meet `formula-interpreter`.
 *
 * Responsibilities:
 *   * parse + normalise formula text (utils/formula-text),
 *   * detect missing inputs before invoking anything,
 *   * run the evaluation in an isolated process with a hard timeout,
 *   * round numeric results to two decimals at the boundary,
 *   * return the interpreter's own calculation trace.
 */
const { interpretor } = require("formula-interpreter");
const env = require("../config/env");
const logger = require("../utils/logger");
const { getPool } = require("./pool");
const { toEvalString, collectIdentifiers } = require("../utils/formula-text");
const { roundResult } = require("../utils/decimal");

let poolInstance = null;

const loadPool = async () => {
  if (!poolInstance) poolInstance = getPool();
  await poolInstance.start();
  return poolInstance;
};

/**
 * The public `interpretor()` returns its child-process result over a JSON IPC
 * channel, which turns Infinity and NaN into null. The package's own calculation
 * trace still records the real value on its last line, so that is what we read.
 */
function traceIsNonFinite(calculation) {
  if (typeof calculation !== "string") return false;
  const lastLine = (calculation.trimEnd().split("\n").pop() || "").trim();
  return /^=\s*(-?Infinity|NaN)$/.test(lastLine);
}

/** Names this formula reads before anything has run. */
function requiredInputs(formulaText) {
  try {
    const { external, free } = collectIdentifiers(formulaText);
    return [...new Set([...external, ...free])].sort();
  } catch {
    return [];
  }
}

/**
 * Evaluate one formula.
 *
 * @param {string} formulaText  the stored formula text
 * @param {object} inputs       values available as EXTERNAL_VAR.CODE
 * @param {object} [options]
 * @param {string[]} [options.formulaNames] other formula names usable as inputs
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.collectCalculation] default true
 * @param {"pool"|"interpretor"} [options.mode] override EVALUATION_MODE
 * @returns {Promise<{ok:boolean, result:*, calculation:string|null,
 *   error:string|null, timedOut:boolean, durationMs:number,
 *   missingInputs:string[], syntaxError:boolean}>}
 */
async function evaluate(formulaText, inputs = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? env.evaluation.timeoutMs;
  const collectCalculation = options.collectCalculation !== false;
  const mode = options.mode ?? env.evaluation.mode;
  const startedAt = process.hrtime.bigint();

  const fail = (error, extra = {}) => ({
    ok: false,
    result: null,
    calculation: null,
    error,
    timedOut: false,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    missingInputs: [],
    syntaxError: false,
    ...extra,
  });

  let evalString;
  try {
    evalString = toEvalString(formulaText, Object.keys(inputs), options.formulaNames);
  } catch (error) {
    return fail(error.message, { syntaxError: true });
  }

  const missing = requiredInputs(formulaText).filter((name) => !(name in inputs));
  if (missing.length) {
    return fail(`Missing inputs: ${missing.join(", ")}`, { missingInputs: missing });
  }

  let response;
  try {
    if (mode === "interpretor") {
      response = await interpretor(evalString, [], { CODE: inputs }, {
        timeout: timeoutMs,
        memoryInMB: env.evaluation.memoryMb,
      });
    } else {
      const pool = await loadPool();
      response = await pool.run({
        evalString,
        libraries: [],
        EXTERNAL_VAR: { CODE: inputs },
        timeoutMs,
      });
    }
  } catch (error) {
    logger.error("evaluator invocation failed", { error: error.message });
    return fail(`Evaluator failure: ${error.message}`);
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  if (!response || response.status !== 1) {
    const message = (response && response.error) || "Unknown interpreter error";
    return {
      ok: false,
      result: null,
      calculation: null,
      error: message,
      timedOut: message === "Timed out" || Boolean(response && response.timedOut),
      durationMs,
      missingInputs: [],
      syntaxError: false,
    };
  }

  const rounded = roundResult(response.data);
  if (rounded.nonFinite || traceIsNonFinite(response.calculation)) {
    return {
      ok: false,
      result: null,
      calculation: collectCalculation ? response.calculation ?? null : null,
      error: "Result is not a finite number",
      timedOut: false,
      durationMs,
      missingInputs: [],
      syntaxError: false,
    };
  }

  return {
    ok: true,
    result: rounded.value === undefined ? null : rounded.value,
    calculation: collectCalculation ? response.calculation ?? null : null,
    error: null,
    timedOut: false,
    durationMs,
    missingInputs: [],
    syntaxError: false,
  };
}

/** Close the shared pool (tests, graceful shutdown). */
async function shutdown() {
  const { closePool } = require("./pool");
  await closePool();
  poolInstance = null;
}

module.exports = { evaluate, requiredInputs, shutdown };
