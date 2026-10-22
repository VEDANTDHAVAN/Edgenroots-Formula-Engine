const es = `(EXTERNAL_VAR) => { const MATHS = require(__dirname + "/dist/libraries/MATHS/index");
return MATHS.ROUND(EXTERNAL_VAR.CODE.a, 2);
}`;
try {
  const fn = eval(es);
  console.log("eval-in-file:", fn({ CODE: { a: 1.005 } }));
} catch (e) { console.log("err:", e.message); }
