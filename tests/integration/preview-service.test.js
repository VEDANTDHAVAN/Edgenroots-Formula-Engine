import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase, countRows, closeDatabase, pool } from "../helpers/db";
import formulaService from "../../src/services/formula.service";
import previewService from "../../src/services/preview.service";
import { shutdown } from "../../src/execution/evaluator";

const create = (name, formulaText, extra = {}) =>
  formulaService.create({ name, formulaText, createdBy: "test", ...extra });

describe("preview service", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await shutdown();
    await closeDatabase();
  });

  it("evaluates a formula and returns the calculation trace", async () => {
    await create("commission", "amount * rate / 100");

    const result = await previewService.preview({ amount: 1000, rate: 7.5 });

    expect(result.formulas).toHaveLength(1);
    const [formula] = result.formulas;
    expect(formula.name).toBe("commission");
    expect(formula.status).toBe("SUCCESS");
    expect(formula.result).toBe(75);
    expect(formula.calculation).toContain("amount = 1000");
    expect(result.output.commission).toBe(75);
    expect(result.stats).toMatchObject({ evaluated: 1, succeeded: 1, failed: 0, skipped: 0 });
  });

  it("runs dependencies before dependants and feeds results forward", async () => {
    await create("commission", "amount * rate / 100");
    await create("payout", "commission * 0.18");

    const result = await previewService.preview({ amount: 1000, rate: 7.5 });

    expect(result.formulas.map((row) => row.name)).toEqual(["commission", "payout"]);
    expect(result.formulas[1].inputs.commission).toBe(75);
    expect(result.formulas[1].result).toBe(13.5);
  });

  it("skips dependants when a dependency fails", async () => {
    await create("commission", "amount * rate / 100");
    await create("payout", "commission * 0.18");

    const result = await previewService.preview({ amount: 1000 });

    const [commission, payout] = result.formulas;
    expect(commission.status).toBe("FAILED");
    expect(commission.missingInputs).toEqual(["rate"]);
    expect(payout.status).toBe("SKIPPED");
    expect(payout.skipReason).toMatch(/commission/);
    expect(result.stats).toMatchObject({ evaluated: 2, succeeded: 0, failed: 1, skipped: 1 });
  });

  it("writes one run-log row per formula and returns the run uuid", async () => {
    await create("commission", "amount * 1");
    await create("payout", "commission * 2");

    const result = await previewService.preview({ amount: 10 });

    expect(result.runUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await countRows("formula_run_logs")).toBe(2);

    const [rows] = await pool.query(
      "SELECT formula_name, status, result, run_uuid FROM formula_run_logs ORDER BY id"
    );
    expect(rows).toEqual([
      { formula_name: "commission", status: "SUCCESS", result: 10, run_uuid: result.runUuid },
      { formula_name: "payout", status: "SUCCESS", result: 20, run_uuid: result.runUuid },
    ]);
  });

  it("logs failures with their error message", async () => {
    await create("commission", "amount * rate / 100");

    await previewService.preview({ amount: 10 });

    const [rows] = await pool.query(
      "SELECT status, error_message, result FROM formula_run_logs"
    );
    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].error_message).toMatch(/Missing inputs: rate/);
    expect(rows[0].result).toBeNull();
  });

  it("evaluates only the requested formulas", async () => {
    const commission = await create("commission", "amount * 1");
    await create("payout", "commission * 2");

    const result = await previewService.preview(
      { amount: 10 },
      { formulaUuids: [commission.uuid] }
    );

    expect(result.formulas.map((row) => row.name)).toEqual(["commission"]);
  });

  it("rejects an unknown formula uuid", async () => {
    await create("commission", "amount * 1");
    await expect(
      previewService.preview(
        { amount: 1 },
        { formulaUuids: ["00000000-0000-4000-8000-000000000000"] }
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it("evaluates the formula set as of a past timestamp", async () => {
    const created = await create("commission", "amount * 1");
    const [before] = await pool.query("SELECT inserted_at FROM formulas WHERE uuid = ?", [
      created.uuid,
    ]);
    const asOf = new Date(new Date(before[0].inserted_at).getTime() - 1000);

    await create("commission", "amount * 2", {
      uuid: created.uuid,
      expectedVersion: 1,
    });

    const past = await previewService.preview({ amount: 10 }, { asOf: asOf.toISOString() });
    expect(past.formulas).toEqual([]);

    const now = await previewService.preview({ amount: 10 });
    expect(now.formulas[0].result).toBe(20);
  });

  it("bulk-evaluates records under one run uuid", async () => {
    await create("commission", "amount * rate / 100");

    const result = await previewService.bulkPreview([
      { amount: 1000, rate: 7.5 },
      { amount: 2000, rate: 5 },
      { amount: 100 },
    ]);

    expect(result.recordCount).toBe(3);
    expect(result.results.map((row) => row.output.commission)).toEqual([75, 100, undefined]);
    expect(result.stats).toMatchObject({ evaluated: 3, succeeded: 2, failed: 1, skipped: 0 });
    expect(await countRows("formula_run_logs")).toBe(3);

    const [runs] = await pool.query("SELECT DISTINCT run_uuid FROM formula_run_logs");
    expect(runs).toEqual([{ run_uuid: result.runUuid }]);
  });

  it("records durations for every evaluation", async () => {
    await create("commission", "amount * 1");
    const result = await previewService.preview({ amount: 1 });

    expect(result.formulas[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.averageMs).toBeGreaterThanOrEqual(0);
  });
});
