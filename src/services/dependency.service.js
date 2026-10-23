const acorn = require("acorn");

/**
 * Dependency analysis over formula text.
 *
 * Identifiers come from a real parse (acorn), not from regular expressions, so
 * strings, numbers and member names are never mistaken for references.
 */

const { collectIdentifiers, FormulaSyntaxError } = require("../utils/formula-text");

/** Identifiers referenced by a formula that are not JavaScript globals. */
function identifiers(formulaText) {
  try {
    const { external, free } = collectIdentifiers(formulaText);
    return [...new Set([...external, ...free])].sort();
  } catch (error) {
    if (error instanceof FormulaSyntaxError) error.isSyntaxError = true;
    throw error;
  }
}

/**
 * Build the dependency graph of a set of formulas.
 *
 * @param {Array<{name:string, formula_text?:string, formulaText?:string}>} formulas
 * @returns {{ names: Map<string, object>, deps: Map<string, string[]>,
 *   missing: Map<string, string[]> }}
 *   `deps`    - formula name -> referenced *formula* names, sorted
 *   `missing` - formula name -> referenced names that are neither an input nor a
 *               known formula (reported, not fatal: they may be request inputs)
 */
function graph(formulas, { inputs = [] } = {}) {
  const names = new Map(formulas.map((formula) => [formula.name, formula]));
  const inputNames = new Set(inputs);
  const deps = new Map();
  const missing = new Map();

  for (const formula of formulas) {
    const text = formula.formula_text ?? formula.formulaText ?? "";
    let referenced;
    try {
      referenced = identifiers(text);
    } catch {
      referenced = [];
    }
    deps.set(formula.name, referenced.filter((name) => names.has(name)));
    const unresolved = referenced.filter(
      (name) => !names.has(name) && !inputNames.has(name)
    );
    if (unresolved.length) missing.set(formula.name, unresolved);
  }

  return { names, deps, missing };
}

/** Depth-first cycle search; returns the cycle as a closed path or null. */
function cyclePath(deps) {
  const done = new Set();
  const active = new Set();
  const stack = [];

  const visit = (name) => {
    if (active.has(name)) return [...stack.slice(stack.indexOf(name)), name];
    if (done.has(name)) return null;
    active.add(name);
    stack.push(name);
    for (const dependency of deps.get(name) || []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(name);
    done.add(name);
    return null;
  };

  for (const name of deps.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Kahn's algorithm grouped into levels: formulas in one level have no
 * dependency on each other and may run concurrently.
 *
 * @returns {string[][]}
 */
function order(formulas) {
  const { deps } = graph(formulas);
  const remaining = new Map([...deps].map(([name, list]) => [name, new Set(list)]));
  const levels = [];

  while (remaining.size) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (!ready.length) {
      const cycle = cyclePath(deps);
      const error = new Error(
        `Circular dependency: ${cycle ? cycle.join(" -> ") : [...remaining.keys()].join(", ")}`
      );
      error.code = "CIRCULAR_DEPENDENCY";
      error.cycle = cycle;
      throw error;
    }
    levels.push(ready);
    for (const name of ready) remaining.delete(name);
    for (const dependencies of remaining.values()) {
      for (const name of ready) dependencies.delete(name);
    }
  }

  return levels;
}

/**
 * Every formula affected (directly or transitively) if `name` changes.
 * @returns {string[]} sorted names, excluding `name` itself
 */
function impacts(formulas, name) {
  const { deps } = graph(formulas);
  const affected = new Set();
  const queue = [name];

  while (queue.length) {
    const current = queue.shift();
    for (const [candidate, dependencies] of deps) {
      if (dependencies.includes(current) && !affected.has(candidate)) {
        affected.add(candidate);
        queue.push(candidate);
      }
    }
  }
  affected.delete(name);
  return [...affected].sort();
}

/** Longest dependency chain below `name` (used for execution depth reporting). */
function depth(formulas, name) {
  const { deps } = graph(formulas);
  const memo = new Map();
  const visit = (node, seen = new Set()) => {
    if (memo.has(node)) return memo.get(node);
    if (seen.has(node)) return 0;
    const next = new Set(seen).add(node);
    const value =
      (deps.get(node) || []).reduce((max, child) => Math.max(max, visit(child, next) + 1), 0);
    memo.set(node, value);
    return value;
  };
  return visit(name);
}

/** Reference a parsed formula body has to acorn, exposed for tests. */
const parse = (text) => acorn.parse(`(${text})`, { ecmaVersion: 2022 });

module.exports = { identifiers, graph, cyclePath, order, impacts, depth, parse };
