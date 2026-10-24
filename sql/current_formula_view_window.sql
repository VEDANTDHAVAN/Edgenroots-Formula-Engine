-- Current versions using a window function (MySQL 8.0+).
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
