# csvExport.ts

## Purpose
Browser-side CSV export utility using papaparse — triggers a file download from the current page without round-tripping to the server.

## Key exports
- `interface CsvColumn<T>` — `{ header: string; accessor: (row: T) => string | number | null }`
- `downloadCsv<T>(filename, columns, rows): void` — serialises rows via `Papa.unparse`, creates a Blob, and clicks a hidden anchor
- `reportFilename(reportName, from, to): string` — builds `practice-<name>-<from>-to-<to>` for date-range reports
- `asOfFilename(reportName, asOfDate): string` — builds `practice-<name>-asof-<date>` for as-of reports

## Dependencies
- `papaparse` — CSV serialiser with correct quoting/escaping

## Critical notes
- Browser-only — uses `document`, `URL.createObjectURL`, `Blob`. Never import at module scope in an SSR page; call only inside onClick handlers (the doc comment says so explicitly).
- Empty rows still download a header-only CSV so users get the schema rather than a silent no-op.
- `.csv` suffix is appended automatically if missing.
- Auto-revokes the object URL after clicking — no memory leak per download.
- Nullish accessor values coerce to empty string, not the literal `"null"`.
- Does NOT apply formula-injection sanitisation — use `csv.ts`/`csvCell` when exporting user-controlled text to a server-side CSV handler instead.

## Recent changes
- 2026-04-19: Added during PRD-01 Phase 5A (practice users directory, CSV export, Kanban DnD).
