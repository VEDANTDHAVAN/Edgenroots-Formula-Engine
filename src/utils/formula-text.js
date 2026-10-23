const acorn = require("acorn");

/**
 * Formula text is parsed once, here, so the rest of the service never guesses
 * with regular expressions. Two shapes are accepted:
 *
 *   amount * rate / 100                       bare identifiers
 *   EXTERNAL_VAR.CODE.amount * EXTERNAL_VAR.CODE.rate / 100
 *   EXTERNAL_VAR.amount * EXTERNAL_VAR.rate   (normalised to .CODE.)
 *   =amount * rate / 100                      (leading '=' ignored)
 *
 * Every bare identifier that is not a JavaScript global is rewritten to
 * `EXTERNAL_VAR.CODE.<name>` before the interpreter sees it, which is the one
 * variable shape this version of `formula-interpreter` reads reliably.
 */

const GLOBALS = new Set([
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "Date",
  "Infinity",
  "NaN",
  "undefined",
  "null",
  "true",
  "false",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "EXTERNAL_VAR",
]);

const PARSE_OPTIONS = { ecmaVersion: 2022, sourceType: "script", allowAwaitOutsideFunction: false };

/** Strip an optional leading '=' and surrounding whitespace. */
function normalize(formulaText) {
  const text = String(formulaText ?? "").trim();
  return text.startsWith("=") ? text.slice(1).trim() : text;
}

class FormulaSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = "FormulaSyntaxError";
    this.code = "FORMULA_SYNTAX";
  }
}

/** Parse `(<expression>)` and return the AST of the expression. */
function parseExpression(formulaText) {
  const text = normalize(formulaText);
  if (!text) throw new FormulaSyntaxError("Formula is empty");
  let ast;
  try {
    ast = acorn.parse(`(${text})`, PARSE_OPTIONS);
  } catch (error) {
    throw new FormulaSyntaxError(error.message);
  }
  const statement = ast.body[0];
  if (!statement || statement.type !== "ExpressionStatement") {
    throw new FormulaSyntaxError("Formula is not a single expression");
  }
  return statement.expression;
}

const isIdentifierName = (node) =>
  node && node.type === "Identifier" && typeof node.name === "string";

/** `a.b.c` -> ["a","b","c"] when every link is a plain, non-computed member. */
function memberPath(node) {
  const parts = [];
  let current = node;
  while (current && current.type === "MemberExpression" && !current.computed) {
    if (!isIdentifierName(current.property)) return null;
    parts.unshift(current.property.name);
    current = current.object;
  }
  if (!isIdentifierName(current)) return null;
  parts.unshift(current.name);
  return parts;
}

/**
 * Walk the AST and return the identifiers it references.
 *
 * @returns {{ external: Set<string>, free: Set<string> }}
 *   `external` - names read through EXTERNAL_VAR / EXTERNAL_VAR.CODE
 *   `free`     - bare identifiers that are not globals and not member properties
 */
function collectIdentifiers(formulaText) {
  const expression = parseExpression(formulaText);
  const external = new Set();
  const free = new Set();
  const skip = new Set();

  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (skip.has(node)) return;

    if (node.type === "MemberExpression" && !node.computed) {
      const path = memberPath(node);
      if (path && path[0] === "EXTERNAL_VAR") {
        const rest = path.slice(1);
        if (rest.length === 1) external.add(rest[0]);
        else if (rest[0] === "CODE" && rest.length === 2) external.add(rest[1]);
        // Deeper paths (EXTERNAL_VAR.CODE.obj.field) keep the first key.
        else if (rest[0] === "CODE" && rest.length > 2) external.add(rest[1]);
        else throw new FormulaSyntaxError(`Unsupported EXTERNAL_VAR path: ${path.join(".")}`);
        return;
      }
      visit(node.object);
      return;
    }

    if (node.type === "Property" && !node.computed) {
      visit(node.value);
      return;
    }

    if (node.type === "Identifier") {
      if (!GLOBALS.has(node.name)) free.add(node.name);
      return;
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };

  visit(expression);
  return { external, free };
}

/** True when the text parses as an expression. */
function isParsable(formulaText) {
  try {
    parseExpression(formulaText);
    return true;
  } catch {
    return false;
  }
}

/**
 * Produce the JavaScript body handed to the interpreter.
 *
 * @param {string} formulaText
 * @param {Set<string>|string[]} knownNames values that may appear as inputs
 * @param {Set<string>|string[]} [formulaNames] other formulas; also rewritten
 */
function toEvalString(formulaText, knownNames = [], formulaNames = []) {
  const expression = parseExpression(formulaText);
  const names = new Set([...knownNames, ...formulaNames]);
  const text = normalize(formulaText);

  // Fast path: already fully qualified - only the EXTERNAL_VAR.CODE shape is
  // supported, so normalise EXTERNAL_VAR.x to EXTERNAL_VAR.CODE.x.
  if (/\bEXTERNAL_VAR\s*\./.test(text) && !/\bEXTERNAL_VAR\s*\.\s*CODE\s*\./.test(text)) {
    return `return (${text.replace(/\bEXTERNAL_VAR\s*\.\s*/g, "EXTERNAL_VAR.CODE.")});`;
  }
  if (/\bEXTERNAL_VAR\s*\.\s*CODE\s*\./.test(text)) {
    return `return (${text});`;
  }

  // Bare identifiers: rewrite every free name that is a known input/formula.
  const free = collectIdentifiers(text).free;
  let rewritten = text;
  const ordered = [...free].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    if (!names.has(name)) continue;
    const pattern = new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`, "g");
    rewritten = rewritten.replace(pattern, `EXTERNAL_VAR.CODE.${name}`);
  }
  return `return (${rewritten});`;
}

module.exports = {
  normalize,
  parseExpression,
  collectIdentifiers,
  isParsable,
  toEvalString,
  FormulaSyntaxError,
};
