/**
 * Worker process entry point.
 *
 * It runs `formula-interpreter`'s own evaluator module — the exact file the
 * package's public `interpretor()` forks for every call — but keeps the process
 * alive between jobs so the ~1 s Node start-up is paid once per worker instead
 * of once per formula evaluation.
 *
 * `evalJob.js` calls `process.exit()` after answering a single message. The
 * exit is neutralised *before* the module is loaded so the same, unmodified
 * evaluator can serve many messages. The real exit is used for the signals the
 * supervisor sends (`SIGKILL` from the parent cannot be intercepted, which is
 * what makes timeouts effective).
 *
 * Nothing in the package is patched beyond that one call target: evaluation,
 * function parsing, library loading and calculation extraction all run the
 * package's own code.
 */
const realExit = process.exit.bind(process);

process.exit = function neutralisedExit() {
  // Deliberately ignored: the evaluator must survive to handle the next job.
};

process.on("SIGTERM", () => realExit(0));
process.on("disconnect", () => realExit(0));

require("formula-interpreter/dist/evalJob.js");

if (process.send) process.send({ type: "ready" });
