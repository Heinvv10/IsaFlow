# `src/lib/validation.ts`

## Purpose
Tiny set of pure validation helpers for dates, UUIDs, and integer query parameters — no external deps.

## Key exports

- `DATE_RE` — `/^\d{4}-\d{2}-\d{2}$/` regex constant
- `UUID_RE` — `/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i` regex constant
- `isValidDate(s) → boolean` — passes `DATE_RE` AND `Date.parse` (rejects calendar-invalid dates like `2024-02-30`)
- `isValidUUID(s) → boolean` — validates standard UUID v4 format
- `safeInt(value, fallback, max?) → number` — parses an unknown to int; returns `fallback` on NaN; clamps to `[1, max]` (default max = 1000)

## Dependencies
None.

## Critical notes
- **`safeInt` minimum is always 1** — it's designed for pagination (`page`, `pageSize`); do not use it for zero-based values (it will return 1, not 0).
- **`safeInt` max defaults to 1000** — prevents runaway page sizes; pass an explicit `max` when the context differs (e.g. `safeInt(req.query.limit, 20, 200)`).
- **`isValidDate` rejects invalid calendar dates** — `"2024-02-30"` passes the regex but fails `Date.parse`, so it returns `false`. Always use `isValidDate` rather than the regex alone for user-supplied dates.
- **UUID validation is case-insensitive** (`/i` flag) — Postgres UUIDs are lowercase but some clients send mixed case.
- **No Zod dependency** — for heavier schema validation (request bodies) use Zod. These helpers are for lightweight query-param guards in route handlers.
