const Decimal = require("decimal.js");

// Display precision is two decimal places, but the internal precision is high
// enough that rounding only happens once, at the boundary.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * Round a computed value to two decimal places without float display noise
 * (0.30000000000000004 -> 0.3). Integers stay integers; non-numeric values and
 * null/undefined pass through untouched.
 *
 * @returns {{ value: *, nonFinite: boolean }}
 */
function roundResult(value) {
  if (value === null || value === undefined) return { value: null, nonFinite: false };
  if (typeof value === "string" || typeof value === "boolean") {
    return { value, nonFinite: false };
  }
  if (typeof value !== "number") return { value, nonFinite: false };
  if (!Number.isFinite(value)) return { value: null, nonFinite: true };
  const rounded = new Decimal(value).toDecimalPlaces(2).toNumber();
  return { value: Object.is(rounded, -0) ? 0 : rounded, nonFinite: false };
}

/** Convenience wrapper returning just the rounded value. */
const round = (value) => roundResult(value).value;

module.exports = { round, roundResult, Decimal };
