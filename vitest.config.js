const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],
    environment: "node",
    // The evaluator pool forks worker processes and every integration test uses
    // the same MySQL schema, so files run one at a time.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    reporters: ["default"],
  },
});
