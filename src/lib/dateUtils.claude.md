# `src/lib/dateUtils.ts`

## Purpose
Single utility to normalise `Date | string | null | undefined` values to `YYYY-MM-DD` strings — handles the dual `Date`/`string` shape that Postgres/pg returns depending on column type.

## Key exports

- `toISODate(value) → string | null` — returns `"YYYY-MM-DD"` or `null` for null/undefined/unparseable input. Accepts `Date` objects, ISO strings, and `Date.toString()` representations.

## Dependencies
None.

## Critical notes
- **Return is `string | null`**, not `string` — callers must guard for `null` before using the result in SQL or display.
- **Timezone**: `toISODate` calls `d.toISOString()` then slices the date portion. `toISOString()` always uses UTC, so a `Date` representing midnight in UTC+2 will appear as the previous day if the local date was midnight. For display purposes this is usually fine; for DB writes always ensure the source `Date` is timezone-aware or use `fmtDate` from `neon.ts` which has the same behaviour.
- **Prefer over ad-hoc slicing**: `String(row.date).slice(0, 10)` works for string columns; `toISODate` is the robust alternative that handles both `Date` objects and strings uniformly.
- **Does not validate calendar correctness** beyond `isNaN(Date)` — e.g. `"2024-02-30"` will be coerced by the JS `Date` constructor to `2024-03-01`. Use `isValidDate` from `validation.ts` before calling `toISODate` if strict validation is required.
