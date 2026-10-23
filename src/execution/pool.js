const { fork } = require("child_process");
const path = require("path");
const env = require("../config/env");
const logger = require("../utils/logger");

const HOST = path.join(__dirname, "worker-host.js");

/**
 * Supervised pool of evaluator processes.
 *
 * Each worker handles one job at a time and receives exactly the message shape
 * `formula-interpreter`'s public `interpretor()` sends to its fork. A job that
 * exceeds its timeout is killed with SIGKILL — the only reliable way to stop a
 * blocked or non-terminating synchronous computation — and the worker is
 * replaced, so a runaway formula cannot poison later evaluations.
 */
class EvaluatorPool {
  constructor({ size = env.evaluation.workers, memoryMb = env.evaluation.memoryMb, recycleAfter = env.evaluation.recycleAfter } = {}) {
    this.size = Math.max(1, size);
    this.memoryMb = memoryMb;
    this.recycleAfter = recycleAfter;
    this.workers = [];
    this.queue = [];
    this.closed = false;
    this.starting = null;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const boots = [];
      for (let i = 0; i < this.size; i++) {
        const worker = this.#spawn(i);
        this.workers.push(worker);
        boots.push(worker.ready);
      }
      await Promise.all(boots);
    })();
    return this.starting;
  }

  #spawn(index) {
    const child = fork(HOST, [], {
      execArgv: [`--max-old-space-size=${this.memoryMb}`],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      // V8 serialisation keeps Infinity/NaN intact; the default JSON channel
      // would turn them into null and hide a non-finite result.
      serialization: "advanced",
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development" },
    });

    const worker = {
      index,
      child,
      busy: false,
      job: null,
      jobsDone: 0,
      dead: false,
      booted: false,
      ready: null,
    };

    worker.ready = new Promise((resolve, reject) => {
      const onReady = (message) => {
        if (message && message.type === "ready") {
          child.off("message", onReady);
          child.off("exit", onExitBeforeReady);
          worker.booted = true;
          resolve();
        }
      };
      const onExitBeforeReady = (code, signal) => {
        child.off("message", onReady);
        reject(new Error(`Evaluator worker failed to start (code=${code} signal=${signal})`));
      };
      child.on("message", onReady);
      child.once("exit", onExitBeforeReady);
    });
    // Avoid an unhandled rejection when a worker dies during shutdown.
    worker.ready.catch(() => {});

    child.on("message", (message) => this.#onMessage(worker, message));
    child.on("error", (error) => this.#fail(worker, `Evaluator process error: ${error.message}`));
    child.on("exit", (code, signal) => {
      worker.dead = true;
      const reason = `Evaluator process exited unexpectedly (code=${code} signal=${signal})`;
      this.#fail(worker, reason);
      if (!this.closed) this.#replace(worker);
    });

    return worker;
  }

  #replace(worker) {
    const idx = this.workers.indexOf(worker);
    if (idx === -1 || this.closed) return;
    const fresh = this.#spawn(worker.index);
    this.workers[idx] = fresh;
    fresh.ready
      .then(() => this.#drain())
      .catch((error) => logger.error("evaluator restart failed", { error: error.message }));
  }

  #onMessage(worker, message) {
    // The worker's boot handshake is not a result. A replacement worker sends it
    // while a job may already be queued for it, so it must never resolve one.
    if (!message || typeof message.status !== "number") return;
    if (!worker.job) return;
    const { resolve, timer } = worker.job;
    clearTimeout(timer);
    worker.job = null;
    worker.busy = false;
    worker.jobsDone += 1;
    resolve(message);
    this.#maybeRecycle(worker);
    this.#drain();
  }

  #fail(worker, reason) {
    if (!worker.job) return;
    const { resolve, timer } = worker.job;
    clearTimeout(timer);
    worker.job = null;
    worker.busy = false;
    resolve({ status: 0, error: reason, processFailure: true });
  }

  #maybeRecycle(worker) {
    if (this.closed || worker.dead) return;
    if (this.recycleAfter <= 0 || worker.jobsDone < this.recycleAfter) return;
    // Recycle an idle worker to bound any memory drift from long-lived processes.
    worker.dead = true;
    try {
      worker.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    this.#replace(worker);
  }

  #drain() {
    if (!this.queue.length) return;
    const worker = this.workers.find(
      (w) => w.booted && !w.dead && !w.busy && w.job === null
    );
    if (!worker) return;
    const next = this.queue.shift();
    this.#dispatch(worker, next);
  }

  #dispatch(worker, job) {
    worker.busy = true;
    const timer = setTimeout(() => {
      if (worker.job !== job) return;
      worker.job = null;
      worker.busy = false;
      worker.dead = true;
      try {
        worker.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      this.#replace(worker);
      job.resolve({ status: 0, error: "Timed out", timedOut: true });
    }, job.timeoutMs);

    worker.job = { ...job, timer };

    try {
      worker.child.send({
        evalString: job.evalString,
        libraries: job.libraries,
        EXTERNAL_VAR: job.EXTERNAL_VAR,
      });
    } catch (error) {
      clearTimeout(timer);
      worker.job = null;
      worker.busy = false;
      job.resolve({ status: 0, error: `Evaluator unavailable: ${error.message}` });
    }
  }

  /** Run one evaluation. `timeoutMs` is enforced by killing the worker. */
  run({ evalString, libraries = [], EXTERNAL_VAR = {}, timeoutMs = env.evaluation.timeoutMs }) {
    if (this.closed) return Promise.reject(new Error("Evaluator pool is closed"));
    return new Promise((resolve) => {
      const job = { evalString, libraries, EXTERNAL_VAR, timeoutMs, resolve };
      const worker = this.workers.find(
        (w) => w.booted && !w.dead && !w.busy && w.job === null
      );
      if (worker) this.#dispatch(worker, job);
      else this.queue.push(job);
    });
  }

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.resolve({ status: 0, error: "Evaluator pool closed" });
    }
    for (const worker of this.workers) {
      worker.dead = true;
      try {
        worker.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    this.workers = [];
  }

  /** Number of busy workers — used by tests and the benchmark. */
  get stats() {
    return {
      size: this.workers.length,
      busy: this.workers.filter((w) => w.busy).length,
      queued: this.queue.length,
    };
  }
}

let singleton = null;

/** Lazily started shared pool used by the application. */
function getPool() {
  if (!singleton) {
    singleton = new EvaluatorPool();
    singleton.start().catch((error) => {
      logger.error("evaluator pool failed to start", { error: error.message });
    });
  }
  return singleton;
}

async function closePool() {
  if (!singleton) return;
  const pool = singleton;
  singleton = null;
  await pool.close();
}

module.exports = { EvaluatorPool, getPool, closePool };
