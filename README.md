# Edgenroots Formula Engine

Append-only, dependency-ordered formula service on **Node.js + Express 5 + MySQL 8+**, executing every
formula through the mandated [`formula-interpreter`](https://www.npmjs.com/package/formula-interpreter)
package. Formulas are versioned as immutable rows, evaluated in dependency order with per-call timeout
isolation, and every preview run is logged.

Verified on **Node v26.7.0**, **MySQL 9.2.0**, **npm 11.19.0**.

---

## Quick start

```bash
npm install
cp .env.example .env          # then set DB_PASSWORD / DB_ADMIN_PASSWORD
npm run db:setup              # creates `edgenroots` + `edgenroots_test`, the app user, and the schema
npm start                     # http://localhost:3000
npm test                      # 92 tests (unit, integration, concurrency, SQL, HTTP, acceptance)
```

`npm run db:setup` is idempotent; `npm run db:reset` drops both databases first. Both connect with the
**admin** credentials (`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`) and then apply `sql/schema.sql` as the
**application** user, which proves the grants are sufficient.

---

## Data model

| Table | Purpose |
| --- | --- |
| `formulas` | Business table. **Never updated or deleted.** One row per version. |
| `formula_dependencies` | One row per (formula version, referenced formula name). Append-only. |
| `formula_run_logs` | One row per (run, record, formula) — success, failure and skip alike. |
| `formula_locks` | Stable logical lock rows (`uuid:<uuid>`, `name:<name>`) for write serialisation. |

**Current version = the row with the greatest `id` for its `uuid`.** Two views expose it:

* `current_formulas` — aggregate/`MAX(id)` variant; the one the application reads.
* `current_formulas_window` — `ROW_NUMBER() OVER (PARTITION BY uuid ORDER BY id DESC)` variant, kept for
  BI consumers and parity-tested against the aggregate view.

Indexes cover UUID/version history, current-name scans, status, run UUID, and formula/timestamp
reporting. `sql/queries.sql` holds the seven required reports; `npm run audit` executes them and prints
the rows.

### Append-only lifecycle

| Operation | Effect |
| --- | --- |
| create | appends version 1 (`ACTIVE`) |
| change | appends version *n+1*; requires `expectedVersion` |
| deactivate | appends an `INACTIVE` version (refused with `409 DEPENDENCY_IMPACT` if other active formulas reference it, unless `force: true`) |
| rollback | appends a copy of a historical version |

Nothing is ever `UPDATE`d or `DELETE`d. `first_created_at` and `created_by` are carried forward from the
first version.

### Concurrency

Writes for one logical formula serialise on a **stable lock row** in `formula_locks`, taken with
`SELECT … FOR UPDATE` inside the transaction — never on a version row that may not exist yet. The lock
row is created outside the transaction (autocommit) so two transactions cannot deadlock while upgrading
a shared lock. A stale `expectedVersion` returns **HTTP 409** with the current version in `details`.

---

## API

All responses are `{ "data": … }` on success and `{ "error": { code, message, details? } }` on failure.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | liveness + uptime |
| `POST` | `/formulas` | create a formula, or append a new version (`uuid` + `expectedVersion`) |
| `GET` | `/formulas` | current version of every formula (`?status=ACTIVE\|INACTIVE`) |
| `GET` | `/formulas/:uuid/history` | every stored version, oldest first |
| `GET` | `/formulas/:uuid/impact` | active formulas that depend on this one |
| `POST` | `/formulas/:uuid/deactivate` | append an `INACTIVE` version |
| `POST` | `/formulas/:uuid/rollback` | re-append a historical version (`version` or `id`) |
| `POST` | `/formulas/preview` | evaluate one record |
| `POST` | `/formulas/preview/bulk` | evaluate up to 500 records in one run |

### Example

```bash
curl -s localhost:3000/formulas -H 'content-type: application/json' -d '{
  "name": "commission",
  "formulaText": "amount * rate / 100",
  "createdBy": "demo"
}'

curl -s localhost:3000/formulas/preview -H 'content-type: application/json' -d '{
  "input": { "amount": 1000, "rate": 7.5 }
}'
```

```json
{
  "data": {
    "runUuid": "…",
    "formulas": [
      { "name": "commission", "version": 1, "status": "SUCCESS", "result": 75, "calculation": "…" }
    ],
    "output": { "amount": 1000, "rate": 7.5, "commission": 75 },
    "stats": { "evaluated": 1, "succeeded": 1, "failed": 0, "skipped": 0, "successRate": 100 }
  }
}
```

### Formula syntax

Inputs are addressed as `EXTERNAL_VAR.CODE.<name>`; the adapter also accepts `EXTERNAL_VAR.<name>` and
rewrites bare identifiers (found with `acorn`), so `amount * rate / 100` works as written. Formula names
are bare identifiers and become available to dependants as inputs.

* Numeric results are rounded **half-up to two decimals** at every formula boundary using `decimal.js`,
  so `0.1 * 3 / 100` is `0`, not `0.0030000000000000005`.
* `Infinity` / `NaN` are rejected as `Result is not a finite number` — the package JSON-encodes its IPC
  reply, which would otherwise silently turn them into `null`.
* A missing input fails that formula (`missingInputs` lists it) and **skips** its dependants.
* `asOf` (ISO timestamp) evaluates the latest version inserted at or before that instant.

---

## Execution

`src/execution/evaluator.js` is the only place formulas meet the interpreter:

* **`pool` (default)** — a supervised pool of worker processes running the package's own evaluator
  module, with a hard `SIGKILL` watchdog, memory cap, and periodic recycling. This is the primary path.
* **`interpretor`** — the package's public one-shot API, one fork per call. Selectable with
  `EVALUATION_MODE=interpretor` or a per-call `{ mode }` override; used by tests to assert result parity.

Both modes return the interpreter's own `calculation` trace, which is stored in `formula_run_logs`.

### Measured performance

`npm run benchmark` (Node v26.7.0, 4 workers, concurrency 4, timeout 2000 ms):

| scenario | total ms | ms/eval | evals/s | ms/record |
| --- | --- | --- | --- | --- |
| pool, sequential (2000 evals) | 3331.98 | 1.666 | 600.2 | – |
| pool, concurrency 4 (2000 evals) | 3286.88 | 1.643 | 608.5 | – |
| pool, 500 records × 3 formulas (1500 evals) | 3135.13 | 2.09 | 478.4 | 6.27 |
| `interpretor()`, one fork per call (5 evals) | 4210.87 | 842.175 | 1.2 | – |

The pool is ~500× faster per evaluation than one-shot `interpretor()`, which is why it is the default.
End to end through HTTP, the acceptance test evaluates **500 records × 3 formulas in 5613 ms** (5546 ms
inside the service, including 1500 run-log inserts) — well inside the 30 s budget.

---

## Tests

`npm test` → **8 files, 92 tests, all passing** (44.47 s, real MySQL + real worker processes):

| File | Tests | Covers |
| --- | --- | --- |
| `tests/unit/formula-text.test.js` | 11 | identifier extraction, `EXTERNAL_VAR` rewriting, syntax errors |
| `tests/unit/evaluator.test.js` | 18 | both execution modes, rounding, missing inputs, timeouts, non-finite results |
| `tests/integration/formula-service.test.js` | 14 | create/change/deactivate/rollback, versioning, name clashes, cycles, impact |
| `tests/integration/preview-service.test.js` | 10 | dependency order, skip propagation, as-of, bulk, run logging |
| `tests/integration/concurrency.test.js` | 4 | parallel writers, `expectedVersion` conflicts, lock behaviour |
| `tests/integration/sql-queries.test.js` | 9 | the seven reports, both current-version views, append-only invariants |
| `tests/integration/http.test.js` | 21 | every route, validation errors, 404, error envelope |
| `tests/acceptance/acceptance.test.js` | 5 | the brief's scenarios end to end, including 500 × 3 under 30 s |

Tests run against `edgenroots_test` (`TEST_DB_NAME` overrides it) and truncate it per file. Files run
sequentially because they share one schema and fork worker processes.

---

## Design decisions and trade-offs

* **Rows as versions** preserve auditability, reproducibility and safe rollback; the cost is storage and
  larger history scans. Composite `(uuid, id)` indexes, the latest-row views, log partitioning/archival
  and read replicas keep this viable at millions of versions.
* **Stable lock rows** instead of `SELECT … FOR UPDATE` on the current version: the row always exists, so
  a first-ever insert and a concurrent change serialise correctly, and locks are released by
  `COMMIT`/`ROLLBACK` (no advisory-lock leaks on a pooled connection).
* **Dependency order** is computed in memory from `acorn`-parsed identifiers, one level at a time, with
  up to `EVALUATION_CONCURRENCY` evaluations in flight per level. Cycles are rejected at write time with
  `400 CIRCULAR_DEPENDENCY` and the offending path.
* **Timeout isolation** lives in the worker process, so a runaway formula cannot block the event loop;
  the worker is killed and replaced.
* **Run logging** is one multi-row `INSERT` per request, not one per formula.

## Append-only versioning (written answer)

1. Store every change as a new row to preserve the complete history of formula modifications.
2. Each logical formula retains a stable UUID, while every version receives a unique, auto-incrementing ID.
3. This provides an audit trail showing what changed and when.
4. Previous versions remain available for debugging, comparison, and rollback.
5. Historical formula versions also enable reproducible, as-of-date previews.
6. Deactivation inserts an INACTIVE version instead of deleting existing data.
7. The main cost is increased database storage as versions accumulate.
8. Additional indexes consume storage and increase the cost of inserts.
9. Index the UUID and version ID to make history and current-version lookups efficient.
10. Use a composite index such as (uuid, id) where supported by the actual query patterns.
11. Retrieve the current version using the highest ID per UUID, and inspect query plans to optimize this operation.
12. Paginate historical queries and select only the columns required instead of scanning entire records.
13. Use EXPLAIN ANALYZE, appropriate indexes, and realistic benchmarks to identify slow queries.
14. For millions of versions, consider archival or partitioning only after evaluating MySQL constraints, indexing trade-offs, and historical-query requirements.
15. Monitor table growth, index size, insert latency, and query performance; optimize based on measured workloads rather than deleting historical versions.

## Limitations

* `formula-interpreter`'s helper `libraries` are broken in the installed version (`require is not
  defined` inside its sandbox), so formulas use plain arithmetic and `EXTERNAL_VAR` inputs only.
* The `interpretor` mode costs ~840 ms per call (one fork each); it exists for parity testing and as a
  fallback, not for throughput.
* `asOf` resolves versions by `inserted_at`; clock skew between application hosts would shift the
  boundary.
