import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../src/app";
import { resetDatabase, closeDatabase } from "../helpers/db";
import { shutdown } from "../../src/execution/evaluator";

const api = () => request(app);

const createFormula = (body) => api().post("/formulas").send(body);

describe("HTTP API", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await shutdown();
    await closeDatabase();
  });

  it("GET /health reports ok", async () => {
    const response = await api().get("/health").expect(200);
    expect(response.body.status).toBe("ok");
    expect(typeof response.body.uptimeSeconds).toBe("number");
  });

  it("POST /formulas creates a formula with 201", async () => {
    const response = await createFormula({
      name: "commission",
      formulaText: "amount * rate / 100",
      createdBy: "api-test",
    }).expect(201);

    expect(response.body.data).toMatchObject({
      name: "commission",
      formulaText: "amount * rate / 100",
      status: "ACTIVE",
      version: 1,
      createdBy: "api-test",
    });
    expect(response.body.data.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("POST /formulas rejects an invalid body with 400 and issue paths", async () => {
    const response = await createFormula({ name: "1bad", formulaText: "" }).expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details.issues.map((issue) => issue.path).sort()).toEqual([
      "formulaText",
      "name",
    ]);
  });

  it("POST /formulas rejects unknown fields", async () => {
    const response = await createFormula({
      name: "commission",
      formulaText: "amount * 1",
      surprise: true,
    }).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /formulas rejects invalid syntax with 400 FORMULA_SYNTAX", async () => {
    const response = await createFormula({
      name: "broken",
      formulaText: "amount *",
    }).expect(400);
    expect(response.body.error.code).toBe("FORMULA_SYNTAX");
  });

  it("GET /formulas lists current versions and filters by status", async () => {
    const created = await createFormula({ name: "commission", formulaText: "amount * 1" });
    await createFormula({ name: "payout", formulaText: "commission * 2" });

    const all = await api().get("/formulas").expect(200);
    expect(all.body.data.map((row) => row.name)).toEqual(["commission", "payout"]);

    await api()
      .post(`/formulas/${created.body.data.uuid}/deactivate`)
      .send({ expectedVersion: 1, force: true })
      .expect(200);

    const active = await api().get("/formulas?status=ACTIVE").expect(200);
    expect(active.body.data.map((row) => row.name)).toEqual(["payout"]);

    const inactive = await api().get("/formulas?status=INACTIVE").expect(200);
    expect(inactive.body.data.map((row) => row.name)).toEqual(["commission"]);
  });

  it("GET /formulas rejects an unknown status filter", async () => {
    const response = await api().get("/formulas?status=DELETED").expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /formulas/:uuid/history returns every version", async () => {
    const created = await createFormula({ name: "commission", formulaText: "amount * 1" });
    const uuid = created.body.data.uuid;
    await createFormula({
      uuid,
      name: "commission",
      formulaText: "amount * 2",
      expectedVersion: 1,
    }).expect(201);

    const response = await api().get(`/formulas/${uuid}/history`).expect(200);
    expect(response.body.data.map((row) => row.version)).toEqual([1, 2]);
    expect(response.body.data[1].formulaText).toBe("amount * 2");
  });

  it("GET /formulas/:uuid/history rejects a malformed uuid with 400", async () => {
    const response = await api().get("/formulas/not-a-uuid/history").expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /formulas/:uuid/history returns 404 for an unknown uuid", async () => {
    const response = await api()
      .get("/formulas/00000000-0000-4000-8000-000000000000/history")
      .expect(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("GET /formulas/:uuid/impact lists dependants", async () => {
    const base = await createFormula({ name: "commission", formulaText: "amount * 1" });
    await createFormula({ name: "payout", formulaText: "commission * 2" });

    const response = await api().get(`/formulas/${base.body.data.uuid}/impact`).expect(200);
    expect(response.body.data.impactedFormulas).toEqual([
      { uuid: expect.any(String), name: "payout", version: 1 },
    ]);
    expect(response.body.data.impactedCount).toBe(1);
  });

  it("POST /formulas/:uuid/deactivate returns 409 when dependants exist", async () => {
    const base = await createFormula({ name: "commission", formulaText: "amount * 1" });
    await createFormula({ name: "payout", formulaText: "commission * 2" });

    const response = await api()
      .post(`/formulas/${base.body.data.uuid}/deactivate`)
      .send({ expectedVersion: 1 })
      .expect(409);

    expect(response.body.error.code).toBe("DEPENDENCY_IMPACT");
    expect(response.body.error.details.dependents).toEqual(["payout"]);
  });

  it("POST /formulas/:uuid/deactivate returns 409 on a stale version", async () => {
    const created = await createFormula({ name: "commission", formulaText: "amount * 1" });
    const uuid = created.body.data.uuid;
    await createFormula({ uuid, name: "commission", formulaText: "amount * 2", expectedVersion: 1 });

    const response = await api()
      .post(`/formulas/${uuid}/deactivate`)
      .send({ expectedVersion: 1 })
      .expect(409);

    expect(response.body.error.code).toBe("VERSION_CONFLICT");
    expect(response.body.error.details).toMatchObject({ expectedVersion: 1, currentVersion: 2 });
  });

  it("POST /formulas/:uuid/rollback restores a historical version", async () => {
    const created = await createFormula({ name: "commission", formulaText: "amount * 1" });
    const uuid = created.body.data.uuid;
    await createFormula({ uuid, name: "commission", formulaText: "amount * 2", expectedVersion: 1 });

    const response = await api()
      .post(`/formulas/${uuid}/rollback`)
      .send({ version: 1, expectedVersion: 2 })
      .expect(200);

    expect(response.body.data).toMatchObject({
      version: 3,
      formulaText: "amount * 1",
      restoredFrom: { version: 1, id: 1 },
    });
  });

  it("POST /formulas/:uuid/rollback requires a target version", async () => {
    const created = await createFormula({ name: "commission", formulaText: "amount * 1" });
    const response = await api()
      .post(`/formulas/${created.body.data.uuid}/rollback`)
      .send({ expectedVersion: 1 })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /formulas/preview evaluates one record", async () => {
    await createFormula({ name: "commission", formulaText: "amount * rate / 100" });

    const response = await api()
      .post("/formulas/preview")
      .send({ input: { amount: 1000, rate: 7.5 } })
      .expect(200);

    expect(response.body.data.formulas[0]).toMatchObject({
      name: "commission",
      status: "SUCCESS",
      result: 75,
    });
    expect(response.body.data.output.commission).toBe(75);
    expect(response.body.data.runUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.data.requestDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("POST /formulas/preview rejects a non-scalar input value", async () => {
    const response = await api()
      .post("/formulas/preview")
      .send({ input: { amount: { nested: true } } })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /formulas/preview/bulk evaluates many records", async () => {
    await createFormula({ name: "commission", formulaText: "amount * 0.1" });

    const response = await api()
      .post("/formulas/preview/bulk")
      .send({ records: [{ amount: 100 }, { amount: 200 }] })
      .expect(200);

    expect(response.body.data.recordCount).toBe(2);
    expect(response.body.data.results.map((row) => row.output.commission)).toEqual([10, 20]);
    expect(response.body.data.stats).toMatchObject({ evaluated: 2, succeeded: 2 });
  });

  it("POST /formulas/preview/bulk rejects more than 500 records", async () => {
    const records = Array.from({ length: 501 }, () => ({ amount: 1 }));
    const response = await api().post("/formulas/preview/bulk").send({ records }).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for an unknown route", async () => {
    const response = await api().get("/nope").expect(404);
    expect(response.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "No route for GET /nope",
    });
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await api()
      .post("/formulas")
      .set("Content-Type", "application/json")
      .send('{"name":')
      .expect(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
  });
});
