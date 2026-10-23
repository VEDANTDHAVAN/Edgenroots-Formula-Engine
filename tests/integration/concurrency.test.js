import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase, countRows, closeDatabase, pool } from "../helpers/db";
import formulaService from "../../src/services/formula.service";
import { shutdown } from "../../src/execution/evaluator";

const create = (name, formulaText, extra = {}) =>
  formulaService.create({ name, formulaText, createdBy: "test", ...extra });

describe("concurrent writes", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await shutdown();
    await closeDatabase();
  });

  it("lets exactly one of two writers win the same expectedVersion", async () => {
    const created = await create("commission", "amount * 1");

    const results = await Promise.allSettled([
      create("commission", "amount * 2", { uuid: created.uuid, expectedVersion: 1 }),
      create("commission", "amount * 3", { uuid: created.uuid, expectedVersion: 1 }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      details: { expectedVersion: 1, currentVersion: 2 },
    });

    // One original version plus exactly one appended version.
    expect(await countRows("formulas")).toBe(2);
    const history = await formulaService.history(pool, created.uuid);
    expect(history.map((row) => row.version)).toEqual([1, 2]);
  });

  it("serialises ten concurrent appends into ten distinct versions", async () => {
    const created = await create("commission", "amount * 0");

    // Each writer retries with the version it just observed, so all ten must
    // eventually land as versions 2..11 with no gaps and no duplicates.
    const writers = Array.from({ length: 10 }, async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await formulaService.history(pool, created.uuid);
        const latest = current[current.length - 1].version;
        try {
          return await create("commission", `amount * ${latest + 1}`, {
            uuid: created.uuid,
            expectedVersion: latest,
          });
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
      throw new Error("writer never succeeded");
    });

    const written = await Promise.all(writers);
    expect(written).toHaveLength(10);

    const history = await formulaService.history(pool, created.uuid);
    expect(history.map((row) => row.version)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1)
    );
    expect(new Set(history.map((row) => row.version)).size).toBe(11);
  });

  it("lets exactly one of two creators claim a name", async () => {
    const results = await Promise.allSettled([
      create("commission", "amount * 1"),
      create("commission", "amount * 2"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected.reason).toMatchObject({ status: 409, code: "DUPLICATE_NAME" });
    expect(await countRows("formulas")).toBe(1);
  });

  it("does not leak locks after a failed write", async () => {
    const created = await create("commission", "amount * 1");

    await expect(
      create("commission", "amount * 2", { uuid: created.uuid, expectedVersion: 99 })
    ).rejects.toMatchObject({ status: 409 });

    // A subsequent write on the same key must not block.
    const next = await create("commission", "amount * 2", {
      uuid: created.uuid,
      expectedVersion: 1,
    });
    expect(next.version).toBe(2);

    const [locks] = await pool.query("SELECT lock_key FROM formula_locks ORDER BY lock_key");
    expect(locks.map((row) => row.lock_key)).toEqual([
      `name:commission`,
      `uuid:${created.uuid}`,
    ]);
  });
});
