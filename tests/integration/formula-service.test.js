import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase, countRows, closeDatabase, pool } from "../helpers/db";
import formulaService from "../../src/services/formula.service";
import { shutdown } from "../../src/execution/evaluator";

const create = (name, formulaText, extra = {}) =>
  formulaService.create({ name, formulaText, createdBy: "test", ...extra });

describe("formula service", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await shutdown();
    await closeDatabase();
  });

  it("creates a formula and returns its stored version", async () => {
    const created = await create("commission", "amount * rate / 100");

    expect(created.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.name).toBe("commission");
    expect(created.formulaText).toBe("amount * rate / 100");
    expect(created.status).toBe("ACTIVE");
    expect(created.version).toBe(1);
    expect(created.createdBy).toBe("test");
    expect(created.previousVersion).toBeNull();
    expect(await countRows("formulas")).toBe(1);
  });

  it("appends a new version instead of updating the row", async () => {
    const created = await create("commission", "amount * rate / 100");
    const changed = await create("commission", "amount * rate / 200", {
      uuid: created.uuid,
      expectedVersion: 1,
    });

    expect(changed.version).toBe(2);
    expect(changed.previousVersion).toBe(1);
    expect(await countRows("formulas")).toBe(2);

    const history = await formulaService.history(pool, created.uuid);
    expect(history.map((row) => row.version)).toEqual([1, 2]);
    expect(history[0].formulaText).toBe("amount * rate / 100");
    expect(history[1].formulaText).toBe("amount * rate / 200");
  });

  it("rejects a stale expectedVersion with 409 and the current version", async () => {
    const created = await create("commission", "amount * 1");
    await create("commission", "amount * 2", { uuid: created.uuid, expectedVersion: 1 });

    await expect(
      create("commission", "amount * 3", { uuid: created.uuid, expectedVersion: 1 })
    ).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      details: { expectedVersion: 1, currentVersion: 2 },
    });
  });

  it("requires expectedVersion when changing an existing formula", async () => {
    const created = await create("commission", "amount * 1");
    await expect(
      create("commission", "amount * 2", { uuid: created.uuid })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a duplicate active name", async () => {
    await create("commission", "amount * 1");
    await expect(create("commission", "amount * 2")).rejects.toMatchObject({
      status: 409,
      code: "DUPLICATE_NAME",
    });
  });

  it("rejects invalid syntax before storing anything", async () => {
    await expect(create("broken", "amount *")).rejects.toMatchObject({
      status: 400,
      code: "FORMULA_SYNTAX",
    });
    expect(await countRows("formulas")).toBe(0);
  });

  it("rejects a formula that cannot be evaluated", async () => {
    await expect(create("broken", "amount +")).rejects.toMatchObject({ status: 400 });
    expect(await countRows("formulas")).toBe(0);
  });

  it("stores dependency edges for referenced formulas", async () => {
    const base = await create("commission", "amount * rate / 100");
    const derived = await create("payout", "commission * 0.18");

    const [edges] = await pool.query(
      "SELECT formula_name, depends_on_name FROM formula_dependencies ORDER BY id"
    );
    expect(edges).toEqual([{ formula_name: "payout", depends_on_name: "commission" }]);

    const impact = await formulaService.impact(pool, base.uuid);
    expect(impact.impactedFormulas).toEqual([
      { uuid: derived.uuid, name: "payout", version: 1 },
    ]);
  });

  it("rejects a circular dependency", async () => {
    const a = await create("alpha", "beta + 1");
    await expect(create("beta", "alpha + 1")).rejects.toMatchObject({
      status: 400,
      code: "CIRCULAR_DEPENDENCY",
    });
    expect(await countRows("formulas")).toBe(1);
    expect(a.name).toBe("alpha");
  });

  it("deactivates by appending an INACTIVE version", async () => {
    const created = await create("commission", "amount * 1");
    const deactivated = await formulaService.deactivate(created.uuid, {
      expectedVersion: 1,
      createdBy: "test",
    });

    expect(deactivated.status).toBe("INACTIVE");
    expect(deactivated.version).toBe(2);
    expect(deactivated.formulaText).toBe("amount * 1");

    const active = await formulaService.list(pool, { status: "ACTIVE" });
    expect(active).toEqual([]);
  });

  it("protects a formula that other active formulas depend on", async () => {
    const base = await create("commission", "amount * 1");
    await create("payout", "commission * 2");

    await expect(
      formulaService.deactivate(base.uuid, { expectedVersion: 1, createdBy: "test" })
    ).rejects.toMatchObject({
      status: 409,
      code: "DEPENDENCY_IMPACT",
      details: { dependents: ["payout"] },
    });

    const forced = await formulaService.deactivate(base.uuid, {
      expectedVersion: 1,
      force: true,
      createdBy: "test",
    });
    expect(forced.status).toBe("INACTIVE");
    expect(forced.dependentFormulas).toEqual(["payout"]);
  });

  it("rolls back by appending a copy of a historical version", async () => {
    const created = await create("commission", "amount * 1");
    await create("commission", "amount * 2", { uuid: created.uuid, expectedVersion: 1 });

    const restored = await formulaService.rollback(created.uuid, {
      version: 1,
      expectedVersion: 2,
      createdBy: "test",
    });

    expect(restored.version).toBe(3);
    expect(restored.formulaText).toBe("amount * 1");
    expect(restored.restoredFrom).toEqual({ version: 1, id: 1 });
    expect(await countRows("formulas")).toBe(3);
  });

  it("rejects a rollback to a version that does not exist", async () => {
    const created = await create("commission", "amount * 1");
    await expect(
      formulaService.rollback(created.uuid, { version: 9, expectedVersion: 1, createdBy: "test" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 404 for an unknown formula", async () => {
    await expect(
      formulaService.history(pool, "00000000-0000-4000-8000-000000000000")
    ).rejects.toMatchObject({ status: 404 });
  });
});
