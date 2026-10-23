/**
 * Test helpers for the two execution paths.
 *
 * `evaluateThrough` runs one formula through a chosen execution mode so a test
 * can compare the public `interpretor()` path (one fork per call) with the
 * persistent worker pool.
 */
const { evaluate, shutdown } = require("../../src/execution/evaluator");

async function evaluateThrough(mode, formulaText, inputs, options = {}) {
  return evaluate(formulaText, inputs, { ...options, mode });
}

module.exports = { evaluateThrough, shutdown };
