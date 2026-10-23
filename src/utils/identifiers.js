const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `value` is a safe, unquoted SQL identifier. */
const isIdentifier = (value) =>
  typeof value === "string" && value.length <= 64 && IDENTIFIER_PATTERN.test(value);

/**
 * Validate an identifier against a pattern and (optionally) against an
 * allow-list. Never interpolate an unvalidated string into SQL.
 */
const assertIdentifier = (value, label, allowed) => {
  if (!isIdentifier(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  if (allowed && !allowed.includes(value)) {
    throw new Error(`Unsupported ${label}: ${JSON.stringify(value)}`);
  }
  return value;
};

/** Validate a dotted, optionally backticked identifier such as `db.table`. */
const assertQualifiedIdentifier = (value, label) => {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
};

module.exports = { isIdentifier, assertIdentifier, assertQualifiedIdentifier, IDENTIFIER_PATTERN };
