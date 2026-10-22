CREATE TABLE formulas (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, uuid CHAR(36) NOT NULL, name VARCHAR(128) NOT NULL, formula_text TEXT NOT NULL, status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE', created_by VARCHAR(128) NOT NULL, first_created_at DATETIME(6) NOT NULL, inserted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), version INT UNSIGNED NOT NULL, UNIQUE KEY uq_formula_uuid_version(uuid,version), KEY ix_formula_uuid_id(uuid,id), KEY ix_formula_name(name), KEY ix_formula_status(status), KEY ix_formula_inserted(uuid,inserted_at)
) ENGINE=InnoDB;
CREATE TABLE formula_run_logs (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, run_uuid CHAR(36) NOT NULL, formula_uuid CHAR(36) NOT NULL, formula_version INT UNSIGNED NOT NULL, input_values JSON NOT NULL, result DECIMAL(30,10) NULL, calculation_text TEXT NULL, status ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL, error_message TEXT NULL, skip_reason TEXT NULL, duration_ms INT UNSIGNED NULL, executed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), KEY ix_log_run(run_uuid), KEY ix_log_formula_time(formula_uuid,executed_at), KEY ix_log_status(status)
) ENGINE=InnoDB;
CREATE OR REPLACE VIEW current_formulas AS SELECT f.* FROM formulas f JOIN (SELECT uuid,MAX(id) id FROM formulas GROUP BY uuid) x ON x.id=f.id;
