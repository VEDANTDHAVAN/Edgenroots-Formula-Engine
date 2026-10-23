const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const setLevel = (level) => {
  threshold = LEVELS[level] ?? threshold;
};

const write = (level, message, meta) => {
  if (LEVELS[level] < threshold) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};

module.exports = {
  setLevel,
  debug: (m, meta) => write("debug", m, meta),
  info: (m, meta) => write("info", m, meta),
  warn: (m, meta) => write("warn", m, meta),
  error: (m, meta) => write("error", m, meta),
};
