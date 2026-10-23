-- Edgenroots Formula Engine — the seven required reporting queries.
-- Target: MySQL 8.0+ (verified against MySQL 9.2).
-- Every query reads the append-only `formulas` / `formula_dependencies` /
-- `formula_run_logs` tables created by sql/schema.sql.

-- ---------------------------------------------------------------------------
-- 1. Version history with version numbers
--    One row per stored version, newest first per formula.
-- ---------------------------------------------------------------------------
SELECT
  f.uuid,
  f.version,
  f.version AS version_number,
  f.name,
  f.status,
  f.formula_text,
  f.created_by,
  f.first_created_at,
  f.inserted_at
FROM formulas f
ORDER BY f.uuid, f.version;

-- ---------------------------------------------------------------------------
-- 2. Active formulas in execution (dependency) order
--    Recursive CTE over the dependency edges of the current version.
--    Level 0 = no dependencies; a dependent always sorts after its dependencies.
-- ---------------------------------------------------------------------------
WITH RECURSIVE
  current_version AS (
    SELECT c.uuid, c.name, c.id
    FROM current_formulas c
    WHERE c.status = 'ACTIVE'
  ),
  current_edges AS (
    SELECT d.formula_name AS dependent, d.depends_on_name AS dependency
    FROM formula_dependencies d
    JOIN current_formulas c ON c.id = d.formula_id
    WHERE c.status = 'ACTIVE'
  ),
  levels AS (
    SELECT cv.name, 0 AS level
    FROM current_version cv
    WHERE NOT EXISTS (
      SELECT 1 FROM current_edges e WHERE e.dependent = cv.name
    )
    UNION ALL
    SELECT e.dependent, l.level + 1
    FROM levels l
    JOIN current_edges e ON e.dependency = l.name
  )
SELECT
  cv.name,
  cv.uuid,
  MAX(l.level) AS dependency_level
FROM levels l
JOIN current_version cv ON cv.name = l.name
GROUP BY cv.uuid, cv.name
ORDER BY dependency_level, cv.name;

-- ---------------------------------------------------------------------------
-- 3. Versions per formula
-- ---------------------------------------------------------------------------
SELECT
  c.uuid,
  c.name,
  c.version       AS current_version,
  c.status        AS current_status,
  COUNT(f.id)     AS version_count,
  MIN(f.inserted_at) AS first_inserted_at,
  MAX(f.inserted_at) AS last_inserted_at
FROM current_formulas c
JOIN formulas f ON f.uuid = c.uuid
GROUP BY c.uuid, c.name, c.version, c.status
ORDER BY version_count DESC, c.name;

-- ---------------------------------------------------------------------------
-- 4. Runs / failures / failure percentage per formula, last seven days
-- ---------------------------------------------------------------------------
SELECT
  l.formula_uuid,
  MAX(l.formula_name)                          AS formula_name,
  COUNT(*)                                     AS total_runs,
  SUM(l.status = 'SUCCESS')                    AS successes,
  SUM(l.status = 'FAILED')                     AS failures,
  SUM(l.status = 'SKIPPED')                    AS skipped,
  ROUND(100 * SUM(l.status = 'FAILED') / COUNT(*), 2) AS failure_percentage
FROM formula_run_logs l
WHERE l.executed_at >= UTC_TIMESTAMP(6) - INTERVAL 7 DAY
GROUP BY l.formula_uuid
ORDER BY failures DESC, total_runs DESC;

-- ---------------------------------------------------------------------------
-- 5. Five most-failing formulas with their latest error message
-- ---------------------------------------------------------------------------
WITH recent AS (
  SELECT *
  FROM formula_run_logs
  WHERE executed_at >= UTC_TIMESTAMP(6) - INTERVAL 7 DAY
),
totals AS (
  SELECT
    formula_uuid,
    MAX(formula_name)             AS formula_name,
    COUNT(*)                      AS total_runs,
    SUM(status = 'FAILED')        AS failures,
    ROUND(100 * SUM(status = 'FAILED') / COUNT(*), 2) AS failure_percentage
  FROM recent
  GROUP BY formula_uuid
  HAVING failures > 0
),
latest_failure AS (
  SELECT
    formula_uuid,
    error_message,
    executed_at AS failed_at,
    ROW_NUMBER() OVER (PARTITION BY formula_uuid ORDER BY executed_at DESC, id DESC) AS rn
  FROM recent
  WHERE status = 'FAILED'
)
SELECT
  t.formula_uuid,
  t.formula_name,
  t.total_runs,
  t.failures,
  t.failure_percentage,
  lf.error_message AS latest_error,
  lf.failed_at     AS latest_error_at
FROM totals t
LEFT JOIN latest_failure lf ON lf.formula_uuid = t.formula_uuid AND lf.rn = 1
ORDER BY t.failures DESC, t.failure_percentage DESC, t.formula_name
LIMIT 5;

-- ---------------------------------------------------------------------------
-- 6. Formulas deactivated and never reactivated
--    Currently INACTIVE and no ACTIVE version was appended after the first
--    INACTIVE version.
-- ---------------------------------------------------------------------------
WITH first_deactivation AS (
  SELECT uuid, MIN(id) AS id
  FROM formulas
  WHERE status = 'INACTIVE'
  GROUP BY uuid
),
reactivated AS (
  SELECT f.uuid
  FROM formulas f
  JOIN first_deactivation d ON d.uuid = f.uuid
  WHERE f.status = 'ACTIVE' AND f.id > d.id
  GROUP BY f.uuid
)
SELECT
  c.uuid,
  c.name,
  c.version            AS deactivated_at_version,
  f.inserted_at        AS deactivated_at,
  f.created_by         AS deactivated_by
FROM current_formulas c
JOIN first_deactivation d ON d.uuid = c.uuid
JOIN formulas f ON f.id = d.id
LEFT JOIN reactivated r ON r.uuid = c.uuid
WHERE c.status = 'INACTIVE'
  AND r.uuid IS NULL
ORDER BY f.inserted_at;

-- ---------------------------------------------------------------------------
-- 7. Time between consecutive versions, plus the average change interval
-- ---------------------------------------------------------------------------
WITH version_gaps AS (
  SELECT
    uuid,
    version,
    name,
    inserted_at,
    LAG(inserted_at) OVER (PARTITION BY uuid ORDER BY version) AS previous_inserted_at
  FROM formulas
),
intervals AS (
  SELECT
    uuid,
    version,
    name,
    previous_inserted_at,
    inserted_at,
    TIMESTAMPDIFF(SECOND, previous_inserted_at, inserted_at) AS seconds_since_previous_version
  FROM version_gaps
  WHERE previous_inserted_at IS NOT NULL
)
SELECT
  i.uuid,
  i.version,
  i.name,
  i.previous_inserted_at,
  i.inserted_at,
  i.seconds_since_previous_version,
  ROUND(
    AVG(i.seconds_since_previous_version) OVER (PARTITION BY i.uuid), 2
  ) AS average_seconds_between_versions
FROM intervals i
ORDER BY i.uuid, i.version;

-- 7b. Average change interval across all formulas (overall summary row).
WITH version_gaps AS (
  SELECT
    uuid,
    inserted_at,
    LAG(inserted_at) OVER (PARTITION BY uuid ORDER BY version) AS previous_inserted_at
  FROM formulas
)
SELECT
  COUNT(*)                                                  AS observed_intervals,
  ROUND(AVG(TIMESTAMPDIFF(SECOND, previous_inserted_at, inserted_at)), 2)
                                                            AS average_seconds_between_versions,
  MIN(TIMESTAMPDIFF(SECOND, previous_inserted_at, inserted_at)) AS min_seconds,
  MAX(TIMESTAMPDIFF(SECOND, previous_inserted_at, inserted_at)) AS max_seconds
FROM version_gaps
WHERE previous_inserted_at IS NOT NULL;
