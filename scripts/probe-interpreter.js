// Scratch probe for formula-interpreter behavior (Phase 1 investigation)
const { interpretor, showLibAndProperties } = require("formula-interpreter");

async function main() {
  // 1. Simple formula, payload accessed directly (readme style)
  let r = await interpretor("return 1 + 1", [], null, { timeout: 3000 });
  console.log("T1 simple:", JSON.stringify(r));

  // 2. Payload direct keys
  r = await interpretor("return SUM(sales) + BONUS;", ["MATHS"], { sales: [100, 200, 300], BONUS: 50 }, { timeout: 3000 });
  console.log("T2 direct payload:", JSON.stringify(r));

  // 3. EXTERNAL_VAR.CODE style
  r = await interpretor("return EXTERNAL_VAR.CODE.amount * 2;", [], { CODE: { amount: 100 } }, { timeout: 3000 });
  console.log("T3 CODE style:", JSON.stringify(r));

  // 4. Error case (syntax)
  r = await interpretor("return === ;", [], null, { timeout: 3000 });
  console.log("T4 syntax error:", JSON.stringify(r));

  // 5. Runtime error (undefined var)
  r = await interpretor("return foo + 1;", [], {}, { timeout: 3000 });
  console.log("T5 undefined var:", JSON.stringify(r));

  // 6. Timeout (infinite loop)
  const t0 = Date.now();
  r = await interpretor("while(true){}", [], null, { timeout: 1500 });
  console.log("T6 timeout:", JSON.stringify(r), "elapsed:", Date.now() - t0, "ms");

  // 7. Calculation text with CODE vars
  r = await interpretor("return EXTERNAL_VAR.CODE.amount + EXTERNAL_VAR.CODE.rate;", [], { CODE: { amount: 2000, rate: 10 } }, { timeout: 3000 });
  console.log("T7 calc text:", JSON.stringify(r.calculation));

  // 8. IF / ROUND helpers
  r = await interpretor("return ROUND(IF(EXTERNAL_VAR.CODE.amount > 100, EXTERNAL_VAR.CODE.amount * 0.1, 0), 2);", ["MATHS", "LOGICAL"], { CODE: { amount: 2000 } }, { timeout: 3000 });
  console.log("T8 helpers:", JSON.stringify(r));

  // 9. Timing of a single fork
  const t1 = Date.now();
  await interpretor("return 1;", [], null, { timeout: 3000 });
  console.log("T9 single eval elapsed:", Date.now() - t1, "ms");

  // 10. 0.1 + 0.2
  r = await interpretor("return 0.1 + 0.2;", [], null, { timeout: 3000 });
  console.log("T10 float:", JSON.stringify(r));

  // 11. Library list
  console.log("T11 libs:", showLibAndProperties(null, null, false));
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
