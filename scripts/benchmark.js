#!/usr/bin/env node
/**
 * Measured throughput of the evaluation layer.
 *
 *   npm run benchmark
 *
 * Everything here runs through `src/execution/evaluator.js`, i.e. the same code
 * path the HTTP API uses. No database is touched: the benchmark measures the
 * interpreter boundary (worker pool vs. one-shot `interpretor()`), which is the
 * part that dominates a preview request.
 *
 * The three-formula chain mirrors the acceptance scenario:
 *   commission = amount * rate / 100
 *   tax        = commission * 0.18
 *   total      = commission + tax
 */
const { evaluate, shutdown } = require("../src/execution/evaluator");
const { getPool } = require("../src/execution/pool");
const env = require("../src/config/env");

const CHAIN = [
  { name: "commission", text: "amount * rate / 100" },
  { name: "tax", text: "commission * 0.18" },
  { name: "total", text: "commission + tax" },
];
const CHAIN_NAMES = CHAIN.map((formula) => formula.name);

const SEQUENTIAL_EVALS = Number(process.env.BENCH_EVALS || 2000);
const CONCURRENT_EVALS = Number(process.env.BENCH_CONCURRENT_EVALS || 2000);
const INTERPRETOR_EVALS = Number(process.env.BENCH_INTERPRETOR_EVALS || 5);
const RECORDS = Number(process.env.BENCH_RECORDS || 500);

const ms = (startedAt) => Number(process.hrtime.bigint() - startedAt) / 1e6;
const fixed = (value, digits = 2) => Number(value.toFixed(digits));

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function assertOk(result, label) {
  if (!result.ok) throw new Error(`${label} failed: ${result.error}`);
  return result;
}

async function sequential() {
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < SEQUENTIAL_EVALS; index++) {
    assertOk(
      await evaluate("amount * rate / 100", { amount: 1000 + index, rate: 7.5 }),
      "sequential"
    );
  }
  const totalMs = ms(startedAt);
  return {
    label: `pool, sequential (${SEQUENTIAL_EVALS} evals)`,
    totalMs,
    perEvalMs: totalMs / SEQUENTIAL_EVALS,
    evalsPerSecond: (SEQUENTIAL_EVALS / totalMs) * 1000,
  };
}

async function concurrent() {
  const startedAt = process.hrtime.bigint();
  await mapLimit(
    Array.from({ length: CONCURRENT_EVALS }, (_, index) => index),
    env.evaluation.concurrency,
    async (index) =>
      assertOk(
        await evaluate("amount * rate / 100", { amount: 1000 + index, rate: 7.5 }),
        "concurrent"
      )
  );
  const totalMs = ms(startedAt);
  return {
    label: `pool, concurrency ${env.evaluation.concurrency} (${CONCURRENT_EVALS} evals)`,
    totalMs,
    perEvalMs: totalMs / CONCURRENT_EVALS,
    evalsPerSecond: (CONCURRENT_EVALS / totalMs) * 1000,
  };
}

/** 500 records x 3 formulas, dependency-ordered, exactly like preview.service. */
async function chain() {
  const startedAt = process.hrtime.bigint();
  let evaluated = 0;

  for (let record = 0; record < RECORDS; record++) {
    const outputs = { amount: 1000 + record, rate: 7.5 };
    for (const formula of CHAIN) {
      const result = assertOk(
        await evaluate(formula.text, { ...outputs }, { formulaNames: CHAIN_NAMES }),
        formula.name
      );
      outputs[formula.name] = result.result;
      evaluated += 1;
    }
    if (record === 0) {
      const expected = { commission: 75, tax: 13.5, total: 88.5 };
      for (const [name, value] of Object.entries(expected)) {
        if (outputs[name] !== value) {
          throw new Error(`chain produced ${name}=${outputs[name]}, expected ${value}`);
        }
      }
    }
  }

  const totalMs = ms(startedAt);
  return {
    label: `pool, ${RECORDS} records x ${CHAIN.length} formulas (${evaluated} evals)`,
    totalMs,
    perEvalMs: totalMs / evaluated,
    evalsPerSecond: (evaluated / totalMs) * 1000,
    perRecordMs: totalMs / RECORDS,
  };
}

/** The public one-shot API: one fork per call. */
async function oneShot() {
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < INTERPRETOR_EVALS; index++) {
    assertOk(
      await evaluate(
        "amount * rate / 100",
        { amount: 1000 + index, rate: 7.5 },
        { mode: "interpretor" }
      ),
      "interpretor"
    );
  }
  const totalMs = ms(startedAt);
  return {
    label: `interpretor(), one fork per call (${INTERPRETOR_EVALS} evals)`,
    totalMs,
    perEvalMs: totalMs / INTERPRETOR_EVALS,
    evalsPerSecond: (INTERPRETOR_EVALS / totalMs) * 1000,
  };
}

function print(rows) {
  const header = ["scenario", "total ms", "ms/eval", "evals/s", "ms/record"];
  const table = rows.map((row) => [
    row.label,
    fixed(row.totalMs),
    fixed(row.perEvalMs, 3),
    fixed(row.evalsPerSecond, 1),
    row.perRecordMs === undefined ? "-" : fixed(row.perRecordMs),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...table.map((line) => String(line[column]).length))
  );
  const line = (cells) =>
    cells.map((cell, column) => String(cell).padEnd(widths[column])).join("  ");

  process.stdout.write(`\n${line(header)}\n${line(widths.map((w) => "-".repeat(w)))}\n`);
  for (const row of table) process.stdout.write(`${line(row)}\n`);
  process.stdout.write("\n");
}

async function main() {
  process.stdout.write(
    `[benchmark] node ${process.version}, ${env.evaluation.workers} workers, ` +
      `concurrency ${env.evaluation.concurrency}, timeout ${env.evaluation.timeoutMs} ms\n`
  );

  // Pay the worker boot cost before the first measurement.
  const pool = getPool();
  const bootStartedAt = process.hrtime.bigint();
  await pool.start();
  process.stdout.write(`[benchmark] pool boot: ${fixed(ms(bootStartedAt))} ms\n`);

  const rows = [];
  rows.push(await sequential());
  rows.push(await concurrent());
  rows.push(await chain());
  rows.push(await oneShot());

  print(rows);
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch(async (error) => {
    process.stderr.write(`[benchmark] failed: ${error.message}\n`);
    await shutdown().catch(() => {});
    process.exit(1);
  });
