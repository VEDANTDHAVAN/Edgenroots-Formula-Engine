CREATE OR REPLACE VIEW current_formulas AS
SELECT f.*
FROM formulas f
JOIN (
  SELECT uuid, MAX(id) AS id
  FROM formulas
  GROUP BY uuid
) latest ON latest.id = f.id;
