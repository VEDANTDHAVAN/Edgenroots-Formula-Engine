-- Edgenroots Formula Engine — schema (MySQL 8.0+, verified on MySQL 9.2)
--
-- Append-only model
--   * `formulas` is the business table. Rows are NEVER updated or deleted.
--   * Every logical formula owns a stable UUID; every change appends a new row
--     with an auto-incrementing id and an incrementing version.
--   * The current version of a formula is the row with the greatest id for its uuid.
--   * Deactivation appends a row with status = 'INACTIVE'; rollback appends a row
--     copied from a historical version.
--   * `first_created_at` / `created_by` are preserved from the first version.

CREATE TABLE IF NOT EXISTS formulas (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid             CHAR(36)        NOT NULL,
  name             VARCHAR(128)    NOT NULL,
  formula_text     TEXT            NOT NULL,
  status           ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by       VARCHAR(128)    NOT NULL,
  first_created_at DATETIME(6)     NOT NULL,
  inserted_at      DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  version          INT UNSIGNED    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_formulas_uuid_version (uuid, version),
  -- "current row per uuid" (views + point lookups): covering, ordered by id.
  KEY ix_formulas_uuid_id (uuid, id),
  -- name lookups / uniqueness checks among active formulas.
  KEY ix_formulas_name_id (name, id),
  -- as-of queries: latest version inserted at or before a timestamp.
  KEY ix_formulas_uuid_inserted (uuid, inserted_at, id),
  KEY ix_formulas_status_id (status, id),
  KEY ix_formulas_inserted (inserted_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Dependency edges, one row per (formula version, referenced formula name).
-- Append-only as well: edges belong to an immutable formula version.
CREATE TABLE IF NOT EXISTS formula_dependencies (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  formula_id     BIGINT UNSIGNED NOT NULL,
  formula_uuid   CHAR(36)        NOT NULL,
  formula_version INT UNSIGNED   NOT NULL,
  formula_name   VARCHAR(128)    NOT NULL,
  depends_on_name VARCHAR(128)   NOT NULL,
  created_at     DATETIME(6)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dep_version_target (formula_id, depends_on_name),
  KEY ix_dep_uuid_version (formula_uuid, formula_version),
  KEY ix_dep_target (depends_on_name),
  CONSTRAINT fk_dep_formula FOREIGN KEY (formula_id) REFERENCES formulas (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per (preview request, record, formula). Append-only audit trail.
CREATE TABLE IF NOT EXISTS formula_run_logs (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_uuid         CHAR(36)        NOT NULL,
  record_index     INT UNSIGNED    NOT NULL DEFAULT 0,
  formula_uuid     CHAR(36)        NOT NULL,
  formula_name     VARCHAR(128)    NOT NULL,
  formula_version  INT UNSIGNED    NOT NULL,
  input_values     JSON            NOT NULL,
  result           DECIMAL(38,10)  NULL,
  calculation_text MEDIUMTEXT      NULL,
  status           ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL,
  error_message    TEXT            NULL,
  skip_reason      TEXT            NULL,
  duration_ms      INT UNSIGNED    NOT NULL DEFAULT 0,
  executed_at      DATETIME(6)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_logs_run (run_uuid, record_index),
  KEY ix_logs_formula_time (formula_uuid, executed_at),
  KEY ix_logs_status_time (status, executed_at),
  KEY ix_logs_time (executed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Stable logical locks. A row exists per lock key ("uuid:<uuid>" / "name:<name>")
-- and is locked with SELECT ... FOR UPDATE for the duration of a write transaction.
-- This never locks a version row that may not exist yet and is released
-- automatically on COMMIT/ROLLBACK (no advisory-lock leaks on a pooled session).
CREATE TABLE IF NOT EXISTS formula_locks (
  lock_key   VARCHAR(191) NOT NULL,
  created_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (lock_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- Current-version views (both required variants)
-- ---------------------------------------------------------------------------

-- Aggregate/subquery variant. This is the view the application uses:
-- the (uuid, id) index answers the GROUP BY without a sort, and MySQL 5.7+
-- supports it (the window variant needs 8.0+).
CREATE OR REPLACE VIEW current_formulas AS
SELECT f.*
FROM formulas f
JOIN (
  SELECT uuid, MAX(id) AS id
  FROM formulas
  GROUP BY uuid
) latest ON latest.id = f.id;

-- Window-function variant, kept for reporting/BI consumers that prefer
-- ROW_NUMBER semantics and for parity testing against the aggregate view.
CREATE OR REPLACE VIEW current_formulas_window AS
SELECT
  ranked.id, ranked.uuid, ranked.name, ranked.formula_text, ranked.status,
  ranked.created_by, ranked.first_created_at, ranked.inserted_at, ranked.version
FROM (
  SELECT
    f.*,
    ROW_NUMBER() OVER (PARTITION BY f.uuid ORDER BY f.id DESC) AS rn
  FROM formulas f
) ranked
WHERE ranked.rn = 1;
