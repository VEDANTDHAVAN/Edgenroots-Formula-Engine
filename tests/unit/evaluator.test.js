import { describe, expect, it } from "vitest";
import { evaluateThrough } from "../helpers/evaluator";

const MODES = ["pool", "interpretor"];

describe.each(MODES)("evaluator (%s mode)", (mode) => {
  it("evaluates bare identifiers", async () => {
    const result = await evaluateThrough(mode, "amount * rate / 100", {
      amount: 1000,
      rate: 7.5,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(75);
    expect(result.calculation).toContain("amount = 1000");
  });

  it("evaluates EXTERNAL_VAR.CODE references", async () => {
    const result = await evaluateThrough(mode, "EXTERNAL_VAR.CODE.amount * 2", {
      amount: 21,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
  });

  it("evaluates the short EXTERNAL_VAR form", async () => {
    const result = await evaluateThrough(mode, "EXTERNAL_VAR.amount + 1", { amount: 41 });
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
  });

  it("rounds to two decimals without float noise", async () => {
    const result = await evaluateThrough(mode, "0.1 + 0.2", {});
    expect(result.ok).toBe(true);
    expect(result.result).toBe(0.3);
  });

  it("keeps integers as integers", async () => {
    const result = await evaluateThrough(mode, "amount * 2", { amount: 5 });
    expect(result.result).toBe(10);
    expect(Number.isInteger(result.result)).toBe(true);
  });

  it("reports missing inputs without invoking the interpreter", async () => {
    const result = await evaluateThrough(mode, "amount + missing", { amount: 1 });
    expect(result.ok).toBe(false);
    expect(result.missingInputs).toEqual(["missing"]);
    expect(result.error).toMatch(/Missing inputs: missing/);
  });

  it("reports syntax errors", async () => {
    const result = await evaluateThrough(mode, "amount *", { amount: 1 });
    expect(result.ok).toBe(false);
    expect(result.syntaxError).toBe(true);
  });

  it("reports a non-finite result as a failure", async () => {
    const result = await evaluateThrough(mode, "amount / 0", { amount: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a finite number/);
  });

  it("returns the interpreter calculation trace", async () => {
    const result = await evaluateThrough(mode, "amount * rate", { amount: 2, rate: 3 });
    expect(result.calculation).toContain("amount = 2");
    expect(result.calculation).toContain("= 6");
  });
});
