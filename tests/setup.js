/**
 * Runs before every test file: points the application at the test database and
 * quiets access logging. dotenv never overrides an existing process.env value,
 * so these win over `.env`.
 */
process.env.NODE_ENV = "test";
process.env.DB_NAME = process.env.TEST_DB_NAME || "edgenroots_test";
process.env.LOG_LEVEL = "silent";
process.env.EVALUATION_MODE = process.env.TEST_EVALUATION_MODE || "pool";
process.env.EVALUATION_WORKERS = process.env.TEST_EVALUATION_WORKERS || "2";
