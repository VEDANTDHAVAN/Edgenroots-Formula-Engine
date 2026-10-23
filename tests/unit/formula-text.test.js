import { describe, expect, it } from "vitest";
import {
  collectIdentifiers,
  isParsable,
  normalize,
  toEvalString,
} from "../../src/utils/formula-text";

describe("formula text parsing", () => {
  it("strips a leading equals sign", () => {
    expect(normalize("  = amount + 1 ")).toBe("amount + 1");
    expect(normalize("amount + 1")).toBe("amount + 1");
  });

  it("collects bare identifiers", () => {
    const { free, external } = collectIdentifiers("amount * rate / 100");
    expect([...free].sort()).toEqual(["amount", "rate"]);
    expect([...external]).toEqual([]);
  });

  it("collects EXTERNAL_VAR.CODE references", () => {
    const { free, external } = collectIdentifiers(
      "EXTERNAL_VAR.CODE.amount * EXTERNAL_VAR.CODE.rate"
    );
    expect([...external].sort()).toEqual(["amount", "rate"]);
    expect([...free]).toEqual([]);
  });

  it("accepts the short EXTERNAL_VAR.<name> form", () => {
    expect([...collectIdentifiers("EXTERNAL_VAR.amount + 1").external]).toEqual(["amount"]);
  });

  it("ignores identifiers inside strings and member names", () => {
    const { free } = collectIdentifiers("'amount' + Math.max(rate, 1)");
    expect([...free]).toEqual(["rate"]);
  });

  it("rejects syntax errors", () => {
    expect(isParsable("amount *")).toBe(false);
    expect(() => collectIdentifiers("amount *")).toThrow(/Unexpected token|Unterminated/);
  });

  it("rewrites bare identifiers to EXTERNAL_VAR.CODE", () => {
    expect(toEvalString("amount * rate / 100", ["amount", "rate"])).toBe(
      "return (EXTERNAL_VAR.CODE.amount * EXTERNAL_VAR.CODE.rate / 100);"
    );
  });

  it("normalises the short EXTERNAL_VAR form", () => {
    expect(toEvalString("EXTERNAL_VAR.amount * 2", ["amount"])).toBe(
      "return (EXTERNAL_VAR.CODE.amount * 2);"
    );
  });

  it("leaves already-qualified text untouched", () => {
    expect(toEvalString("EXTERNAL_VAR.CODE.amount * 2", ["amount"])).toBe(
      "return (EXTERNAL_VAR.CODE.amount * 2);"
    );
  });

  it("does not rewrite identifiers that are not known inputs", () => {
    expect(toEvalString("Math.max(amount, 1)", ["amount"])).toBe(
      "return (Math.max(EXTERNAL_VAR.CODE.amount, 1));"
    );
  });

  it("does not rewrite a name that is a prefix of another", () => {
    expect(toEvalString("rate + rate_total", ["rate", "rate_total"])).toBe(
      "return (EXTERNAL_VAR.CODE.rate + EXTERNAL_VAR.CODE.rate_total);"
    );
  });
});
