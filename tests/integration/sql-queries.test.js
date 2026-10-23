import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase, closeDatabase, pool } from "../helpers/db";
import { loadQueries } from "../helpers/queries";
import formulaService from "../../src/services/formula.service";
import previewService from "../../src/services/preview.service";
import { shutdown } from "../../src/execution/evaluator";

const create = (name, formulaText, extra = {}) =>
  formulaService.create({ name, formulaText, createdBy: "test", ...extra });

const queries = loadQueries();

/** Run one statement from sql/queries.sql and return its rows. */
const run = async (index) => {
  const [rows] = await pool.query(queries[index]);
  return rows;
};

describe("reporting queries", () => {
  let commission;
  let payout;
  let retired;

  beforeAll(async () => {
    await resetDatabase();

    commission = await create("commission", "amount * rate / 100");
    payout = await create("payout", "commission * 0.18");
    retired = await create("legacy", "amount * 1");

    // A second version of commission, so version history and intervals exist.
    await create("commission", "amount * rate / 200", {
      uuid: commission.uuid,
      expectedVersion: 1,
    });

    // Deactivate `legacy` and never reactivate it.
    await formulaService.deactivate(retired.uuid, { expectedVersion: 1, createdBy: "test" });

    // One successful run and one failing run, so the failure reports have data.
    await previewService.preview({ amount: 1000, rate: 7.5 });
    await previewService.preview({ amount: 1000 });
  });

  afterAll(async () => {
    await shutdown();
    await closeDatabase();
  });

  it("exposes exactly the seven report statements", () => {
    expect(queries).toHaveLength(8); // seven reports + the overall interval summary
  });

  it("1. lists every stored version with its version number", async () => {
    const rows = await run(0);
    // Deactivation appends a version too, so `legacy` has two.
    expect(rows).toHaveLength(5);
    // Ordered by uuid, then version.
    expect(rows.map((row) => `${row.name}@${row.version}`).sort()).toEqual([
      "commission@1",
      "commission@2",
      "legacy@1",
      "legacy@2",
      "payout@1",
    ]);
    expect(rows[0].version_number).toBe(rows[0].version);
  });

  it("2. orders active formulas by dependency level", async () => {
    const rows = await run(1);
    expect(rows.map((row) => row.name)).toEqual(["commission", "payout"]);
    expect(rows.map((row) => Number(row.dependency_level))).toEqual([0, 1]);
  });

  it("3. counts versions per formula", async () => {
    const rows = await run(2);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(Number(byName.commission.version_count)).toBe(2);
    expect(Number(byName.payout.version_count)).toBe(1);
    expect(Number(byName.legacy.version_count)).toBe(2);
    expect(byName.legacy.current_status).toBe("INACTIVE");
  });

  it("4. reports runs, failures and failure percentage", async () => {
    const rows = await run(3);
    const byName = Object.fromEntries(rows.map((row) => [row.formula_name, row]));

    expect(Number(byName.commission.total_runs)).toBe(2);
    expect(Number(byName.commission.successes)).toBe(1);
    expect(Number(byName.commission.failures)).toBe(1);
    expect(Number(byName.commission.failure_percentage)).toBe(50);

    // payout ran twice: once successfully, once skipped because commission
    // failed. A skip is logged but is not a failure.
    expect(Number(byName.payout.total_runs)).toBe(2);
    expect(Number(byName.payout.failures)).toBe(0);
    expect(Number(byName.payout.skipped)).toBe(1);
  });

  it("5. lists the five most-failing formulas with the latest error", async () => {
    const rows = await run(4);
    expect(rows).toHaveLength(1);
    expect(rows[0].formula_name).toBe("commission");
    expect(Number(rows[0].failures)).toBe(1);
    expect(rows[0].latest_error).toMatch(/Missing inputs: rate/);
    expect(rows[0].latest_error_at).toBeInstanceOf(Date);
  });

  it("6. lists formulas deactivated and never reactivated", async () => {
    const rows = await run(5);
    expect(rows.map((row) => row.name)).toEqual(["legacy"]);
    expect(Number(rows[0].deactivated_at_version)).toBe(2);
    expect(rows[0].deactivated_by).toBe("test");
  });

  it("7. reports the interval between consecutive versions", async () => {
    const rows = await run(6);
    // Both `commission` and `legacy` gained a second version.
    expect(rows.map((row) => row.name).sort()).toEqual(["commission", "legacy"]);
    const commissionRow = rows.find((row) => row.name === "commission");
    expect(Number(commissionRow.version)).toBe(2);
    expect(Number(commissionRow.seconds_since_previous_version)).toBeGreaterThanOrEqual(0);
    expect(Number(commissionRow.average_seconds_between_versions)).toBeGreaterThanOrEqual(0);
  });

  it("7b. summarises the average change interval across all formulas", async () => {
    const [row] = await run(7);
    expect(Number(row.observed_intervals)).toBe(2);
    expect(Number(row.average_seconds_between_versions)).toBeGreaterThanOrEqual(0);
  });
});
