/**
 * Acceptance: the scenarios from the brief, end to end through the HTTP API.
 *
 *   commission = amount * rate / 100
 *   tax        = commission * 0.18
 *   total      = commission + tax
 *
 * 500 records x 3 formulas must finish well inside the 30 s budget.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../src/app";
import { resetDatabase, closeDatabase, pool } from "../helpers/db";
import { shutdown } from "../../src/execution/evaluator";

const api = () => request(app);

describe("acceptance", () => {
  let commission;
  let tax;
  let total;

  beforeAll(async () => {
    await resetDatabase();

    commission = (
      await api()
        .post("/formulas")
        .send({ name: "commission", formulaText: "amount * rate / 100", createdBy: "acceptance" })
        .expect(201)
    ).body.data;

    tax = (
      await api()
        .post("/formulas")
        .send({ name: "tax", formulaText: "commission * 0.18", createdBy: "acceptance" })
        .expect(201)
    ).body.data;

    total = (
      await api()
        .post("/formulas")
        .send({ name: "total", formulaText: "commission + tax", createdBy: "acceptance" })
        .expect(201)
    ).body.data;
  });

  afterAll(async () => {
    await shutdown();
    await closeDatabase();
  });

  it("evaluates the three-formula chain in dependency order", async () => {
    const response = await api()
      .post("/formulas/preview")
      .send({ input: { amount: 1000, rate: 7.5 } })
      .expect(200);

    const { formulas, output, stats } = response.body.data;

    expect(formulas.map((row) => row.name)).toEqual(["commission", "tax", "total"]);
    expect(formulas.map((row) => row.status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(output.commission).toBe(75);
    expect(output.tax).toBe(13.5);
    expect(output.total).toBe(88.5);
    expect(stats).toMatchObject({ evaluated: 3, succeeded: 3, failed: 0, skipped: 0 });
  });

  it("rounds to two decimals without float artefacts", async () => {
    const response = await api()
      .post("/formulas/preview")
      .send({ input: { amount: 0.1, rate: 3 } })
      .expect(200);

    // 0.1 * 3 / 100 = 0.003 -> 0.00, and 0.18 * 0 = 0
    expect(response.body.data.output.commission).toBe(0);
    expect(response.body.data.output.tax).toBe(0);
    expect(response.body.data.output.total).toBe(0);

    const thirds = await api()
      .post("/formulas/preview")
      .send({ input: { amount: 100, rate: 33.333 } })
      .expect(200);
    // 33.333 -> 33.33; 33.33 * 0.18 = 5.9994 -> 6; 33.33 + 6 = 39.33
    expect(thirds.body.data.output.commission).toBe(33.33);
    expect(thirds.body.data.output.tax).toBe(6);
    expect(thirds.body.data.output.total).toBe(39.33);
  });

  it("reports a missing input and skips its dependants", async () => {
    const response = await api()
      .post("/formulas/preview")
      .send({ input: { amount: 1000 } })
      .expect(200);

    const { formulas, stats } = response.body.data;
    expect(formulas[0]).toMatchObject({ name: "commission", status: "FAILED" });
    expect(formulas[0].missingInputs).toEqual(["rate"]);
    expect(formulas[1]).toMatchObject({ name: "tax", status: "SKIPPED" });
    expect(formulas[2]).toMatchObject({ name: "total", status: "SKIPPED" });
    expect(stats).toMatchObject({ evaluated: 3, succeeded: 0, failed: 1, skipped: 2 });
  });

  it("evaluates 500 records x 3 formulas in one bulk run under 30 s", async () => {
    const records = Array.from({ length: 500 }, (_, index) => ({
      amount: 1000 + index,
      rate: 7.5,
    }));

    const startedAt = Date.now();
    const response = await api()
      .post("/formulas/preview/bulk")
      .send({ records })
      .expect(200);
    const wallClockMs = Date.now() - startedAt;

    const { stats, results, runUuid } = response.body.data;
    expect(results).toHaveLength(500);
    expect(stats).toMatchObject({ evaluated: 1500, succeeded: 1500, failed: 0, skipped: 0 });
    expect(wallClockMs).toBeLessThan(30000);

    // Every record produced the same chain, and the first one is exact.
    expect(results[0].output).toMatchObject({ commission: 75, tax: 13.5, total: 88.5 });
    expect(results[499].output.commission).toBe(112.43);

    const [logs] = await pool.query(
      "SELECT COUNT(*) AS total FROM formula_run_logs WHERE run_uuid = ?",
      [runUuid]
    );
    expect(Number(logs[0].total)).toBe(1500);

    // eslint-disable-next-line no-console
    console.log(
      `[acceptance] 500 records x 3 formulas: ${wallClockMs} ms wall clock, ` +
        `${stats.totalExecutionMs} ms in service`
    );
  }, 60000);

  it("keeps the whole history of every formula", async () => {
    const response = await api().get(`/formulas/${commission.uuid}/history`).expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ version: 1, status: "ACTIVE" });

    const impact = await api().get(`/formulas/${commission.uuid}/impact`).expect(200);
    expect(impact.body.data.impactedFormulas.map((row) => row.name).sort()).toEqual([
      "tax",
      "total",
    ]);

    expect(tax.uuid).not.toBe(total.uuid);
  });
});
