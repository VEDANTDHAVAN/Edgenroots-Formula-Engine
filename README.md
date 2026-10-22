# Edgenroots Formula Engine

Node 24, Express 5, MySQL 8 formula service. Install with `npm install`, copy `.env.example` to `.env`, execute `sql/schema.sql`, then `npm start`. Run `npm test` (tests still need to be added) and `npm run probe` to inspect the required interpreter.

All formula changes are insert-only: `current_formulas` uses highest ID per UUID; historical rows are never updated or deleted. The aggregate view is production-selected for broad MySQL compatibility; the window version is supplied separately. MySQL indexes cover UUID/version history, current-name scans, status, run UUID, and formula/timestamp reporting.

Endpoints: `POST /formulas`, `POST /formulas/:uuid/deactivate`, `POST /formulas/:uuid/rollback`, `GET /formulas`, `GET /formulas/:uuid/history`, `GET /formulas/:uuid/impact`, `POST /formulas/preview`, `POST /formulas/preview/bulk`.

Formula input fields use `EXTERNAL_VAR.CODE.field`; formula names are bare identifiers. Numeric results round half-up to two decimals at formula boundaries, avoiding JavaScript display artifacts. As-of previews select the latest row inserted at or before the supplied ISO timestamp. Deactivation means it is not evaluated as of that version; rollback appends a copy.

Changes as rows preserve auditability, reproducibility, and safe rollback. The cost is storage and larger history scans. Composite UUID/ID indexes, a latest-row view, partitions/archival of logs, retention policy for infrastructure logs, and replicas for reporting keep this viable at millions of versions.

Limitations: a running MySQL 8 server is required for lifecycle/integration verification. The included package probe confirmed `formula-interpreter` result fields, `EXTERNAL_VAR.CODE` input shape, and timeout response; it does not expose IF helpers reliably in this package version. Benchmarking 5000 process-backed interpreter calls has not been run because each invocation has measurable fork overhead.
