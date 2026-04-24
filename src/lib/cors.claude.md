# cors.ts

## Purpose
Single source of truth for the CORS origin allow-list, consumed by both `api-error-handler.ts` and `apiResponse.ts`.

## Key exports
- `const CORS_ALLOWED_ORIGINS: readonly string[]` — frozen allow-list: app.isaflow.co.za, admin.isaflow.co.za, isaflow.co.za, plus localhost:3101/3004 in dev
- `safeCorsOrigin(origin: string | undefined): string` — returns the origin string only if it is in the allow-list, otherwise `''`

## Dependencies
None.

## Critical notes
- Pentest M11: previously this allow-list was duplicated across two files and went out of sync — never re-inline these origins anywhere else. Consume through `safeCorsOrigin()`.
- Callers must check the empty-string return and skip setting any `Access-Control-Allow-*` headers if the origin does not match. Echoing an attacker-controlled origin back in the header bypasses the allow-list.
- Localhost origins are gated on `NODE_ENV === 'development'` — they are not present in production bundles.
- List is `Object.freeze`d — cannot be mutated at runtime.

## Recent changes
- 2026-04-24: Created as part of pentest batch M10–M23 to deduplicate CORS allow-lists.
