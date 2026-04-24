# csv.ts

## Purpose
Server-side CSV cell escaping helpers shared by every export endpoint, with built-in formula-injection sanitisation.

## Key exports
- `csvCell(value: string | number | null | undefined): string` — always double-quote-wraps and escapes embedded quotes; nullish → `""`
- `csvVal(value): string` — alias for `csvCell`; kept so existing callers don't need renaming
- `escapeCsv(value): string` — conditional-quoting variant: only wraps when value contains `,`, `"`, or newline; nullish → empty string (not `""`)

## Dependencies
None.

## Critical notes
- All three helpers run `sanitizeFormulaInjection` first: leading `=`, `+`, `-`, `@`, TAB, or CR is prefixed with a single quote to defeat Excel/Sheets formula execution (OWASP CWE-1236).
- The single-quote prefix lands INSIDE the cell value, before the quote-wrapping — do not re-order.
- `csvCell` and `escapeCsv` behave differently for null: `csvCell(null)` → `""` (quoted empty), `escapeCsv(null)` → empty string (unquoted). Pick based on whether your column is always quoted.
- Do not hand-roll CSV escaping elsewhere — route all user-controlled data through these helpers to keep the CWE-1236 guard centralised.
- Pentest remediation: these helpers were part of the 42-finding pentest fix; altering their behaviour needs a matching pentest ticket.

## Recent changes
- 2026-04-04: Introduced as part of pentest remediation batch (42 findings across 8 attack dimensions).
