# `src/lib/apiFetch.ts`

## Purpose
Browser-side `fetch` wrapper that automatically injects the active company ID header and the CSRF token on mutating requests — use instead of raw `fetch()` for all accounting API calls.

## Key exports

- `apiFetch(url, options?) → Promise<Response>` — drop-in replacement for `fetch`; returns the raw `Response` (callers must handle JSON parsing and error checking themselves).

## Behaviour

| Condition | Action |
|---|---|
| `localStorage.isaflow_active_company` contains `{ id }` | Sets `X-Company-Id: <id>` |
| Method is POST/PUT/PATCH/DELETE and `isaflow_csrf` cookie exists | Sets `X-CSRF-Token: <token>` |
| Body is a string and no `Content-Type` set | Sets `Content-Type: application/json` |
| Always | `credentials: 'include'` (sends cookies) |

## Dependencies
- Browser globals only (`fetch`, `localStorage`, `document.cookie`) — **not for server-side use**.

## Critical notes
- **CSRF (BL-22)**: mirrors the `isaflow_csrf` cookie into `X-CSRF-Token`; the cookie is HttpOnly-safe because the server sets a readable (non-HttpOnly) token. Never skip this wrapper for state-changing calls.
- **Multi-tenant**: the `X-Company-Id` header is how the server determines the active tenant when the session has access to multiple companies. Missing this header = server uses the first company from the session, which may be wrong.
- **No response handling**: `apiFetch` returns `Response`, not parsed JSON. Callers must `await res.json()` and check `json.success` per the `ApiResponse` envelope.
- **Server components / API routes**: do not import `apiFetch` in server-side code — it references `window`/`document`. Use the `sql` tag template directly on the server.
- **Active company storage key**: `'isaflow_active_company'` — if the key or JSON shape ever changes, update `COMPANY_STORAGE_KEY` here and all `localStorage.setItem` call sites.
