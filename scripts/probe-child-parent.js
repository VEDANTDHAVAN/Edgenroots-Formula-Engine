const { fork } = require("child_process");
const path = require("path");
const fs = require("fs");
const child = path.join(__dirname, "probe-child.js");
fs.writeFileSync(child, [
  "process.on('message', (m) => {",
  "  const out = { moduleRequire: typeof require, dirname: __dirname };",
  "  const fn = eval('(x) => { return typeof require + \"/\" + typeof __dirname; }');",
  "  try { out.evalFn = fn(m); } catch (e) { out.evalErr = e.message; }",
  "  process.send(out);",
  "});",
].join("\n"));
const c = fork(child, [], { execArgv: ["--max-old-space-size=10"] });
c.on("message", (m) => { console.log("CHILD RESULT", JSON.stringify(m)); c.disconnect(); });
c.on("exit", (code, sig) => { console.log("child exit", code, sig); fs.unlinkSync(child); });
c.send("x");
