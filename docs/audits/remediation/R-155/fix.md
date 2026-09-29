# R-155, R-156, R-157 — fix (the K-101 portal follow-ups)

These three came out of the K-101 review (K-101/fix.md, Follow-ups). One PR fixes all three, and
this folder holds the evidence for all three.

## Triggers

- **R-155 (token mint race).** `POST /api/portal/invoice/generate` read `portal_token` with a
  SELECT and then wrote a fresh token with a plain `UPDATE ... SET portal_token = $token`. If a
  second mint (the dunning cron, a manual send, or another click) committed in between, the UPDATE
  overwrote it. The link that had already been handed out, or emailed, stopped working. K-122b
  fixed this race in `getOrMintInvoicePortalToken`, but this route never used it.
- **R-156 (duplicate route).** `POST /api/portal/invoice/[token]` minted a token too. It ignored
  `?action=` and duplicated `generate.ts`, with its own copy of the read-then-write. Hein decided
  to delete it.
- **R-157 (a viewer can mint).** `generate.ts` and `payment-link.ts` POST had neither `withCsrf`
  nor `withWriteAccess`. A `viewer` could create a permanent unauthenticated invoice token or a
  payment link, and the request needed no CSRF token. Hein chose `DEFAULT_WRITE_ROLES`
  (owner/admin/manager).
  - **Scope added (Hein, 2026-09-29):** `GET /api/accounting/ar/invoice/[id]/portal-link` minted a
    token as well. `withWriteAccess` and `withCsrf` let every GET through, so after the two routes
    above were fixed, a viewer could still mint by GET. The GET now only reads.

## Prod traffic check before deleting the route (R-156)

The check was read-only. `journalctl -u isaflow` and the nginx access logs contain **no
`/api/portal/` request of any kind**. That means no POST to `/api/portal/invoice/<64hex>`, and no
calls to `generate` either. withErrorHandler logs every request (`API Request: <method> <url>`) and
the same journal holds about 17k other API requests, so the absence is real. The limit is
retention: the journal starts at the last boot (2026-09-25 11:36 SAST) and nginx keeps 14 days. The
repo has no caller for the POST. The only UI mint is the invoice page's "share portal link" button,
which calls `generate`.

## Before / after

| Route | Before | After |
|---|---|---|
| `POST /api/portal/invoice/generate` | SELECT then plain UPDATE; any member role; no CSRF | `findOrMintInvoicePortalToken` (one `COALESCE` UPDATE ... RETURNING; null → 404); `withCsrf(withWriteAccess(...))` |
| `POST /api/portal/invoice/[token]` | a second copy of generate | **405**. The public token GET is unchanged. |
| `POST /api/portal/payment-link` | any member role; no CSRF | `withCsrf(withWriteAccess(...))` |
| `GET /api/accounting/ar/invoice/[id]/portal-link` | minted when no token existed (any role) | reads only: the stored token or 404. Mints nothing. |
| `POST /api/accounting/ar/invoice/[id]/portal-link` | a non-UUID id or an ineligible invoice gave a 500 | 400 for a non-UUID id (`isUuidParam`), 404 for an ineligible invoice |

- `portalTokenService` gains `findOrMintInvoicePortalToken`, which returns null for an invoice
  that is not eligible. `getOrMintInvoicePortalToken`, the dunning path, is now a thin wrapper
  that still throws. Its mint SQL is unchanged, and so is K-122b's guarantee.
- Refusal order: withCsrf and withWriteAccess both run before the handler, so a viewer or a
  request without a CSRF header gets 403 before the first write. withAuth COMMITs a 4xx, so this
  order matters. The tests assert that no token or link row is written and that the mint UPDATE
  is never issued.
- **Behaviour changes.**
  - `generate` now also refuses a **soft-deleted** invoice (404). It used to mint a token for one,
    and that token was dead anyway because the public GET refuses deleted invoices.
  - `generate` logs `Portal token issued` on every call. It used to log only a fresh mint.
  - The `ar/.../portal-link` GET now 404s where it used to mint. Its only callers were the two
    e2e specs, which now mint with POST.
- The invoice page's `apiFetch` sends `X-CSRF-Token` on POST (`src/lib/apiFetch.ts:69-72`), so
  the button keeps working for owner/admin/manager. The browser check is below.

## Tests

`tests/integration/r155-157-portal-mint-guards.int.test.ts` has 28 cases. They run through the
real routes: withAuth as `app_user` with RLS and the membership check, then withErrorHandler.

- **R-155:** for `generate` and `portal-link` POST, a rival write on another connection commits
  between the route's read and its mint UPDATE. The test hooks the `sql` call and asserts that the
  hook fired. The route returns the rival's token and the database still holds it. A soft-deleted
  invoice gets 404 and nothing is minted.
- **R-156:** `POST [token]`, with and without `?action=generate`, gets 405 and no token is written.
  The public GET of a stored token is still 200.
- **R-157:** for each of `generate`, `payment-link` and `portal-link` POST:
  - owner, admin and manager get 200 and the row is written;
  - a viewer gets 403;
  - a request without the CSRF header gets 403.

  Each refusal writes nothing and issues no mint UPDATE.
- **R-157, `portal-link` GET:**
  - a GET by a viewer or an admin on a tokenless invoice gets 404 and mints nothing;
  - a GET after a POST returns the same token and URL;
  - a non-UUID id is 400 for GET and POST;
  - an unknown invoice is 404 for POST.

`tests/integration/k101-portal-routes-use-active-company.int.test.ts` drops the `[token]` POST
route, which is gone. Its other 24 cases are unchanged.

Evidence:

- `red.int.log`: 14 of 28 cases fail on origin/master `6d1f4a488`: the generate race, both
  soft-deleted cases, both 405s, the viewer and no-CSRF cases for generate and payment-link, both
  minting GETs, the two non-UUID 500s, and the unknown-invoice 500.
- `green.log`, all on the fix commit:
  - this suite: 28/28;
  - K-101: 24/24;
  - k122: 6/6;
  - k122b: 3/3;
  - r095: 7/7 + 7/7 + 8/8;
  - customer-ownership-fence-routes, on an `isaflow_test` clone: 32/32;
  - unit tests for `portalTokenService` + `dunningService`: 30/30.
- `mutations.log`: 22/22 mutants RED. Every changed source line was mutated:
  - `COALESCE` removed;
  - the `deleted_at` filter removed;
  - `findOrMint` throwing instead of returning null;
  - `getOrMint` not throwing;
  - `withCsrf` or `withWriteAccess` removed on each of the three routes;
  - the write roles narrowed to owner and admin, on generate and payment-link;
  - each 404 removed;
  - the generate `portalUrl` or the GET `url` not carrying the token;
  - the company taken from the user id;
  - the `[token]` POST served again;
  - the portal-link UUID check removed;
  - the GET minting again, the GET never reading, the POST never minting.
- Fixture: a clone of the peer's `isaflow_schema_fixture` (up to 691) in this session's own
  container, with migrations 692–716 applied and `DATABASE_SSL=disable`. The shared fixture was
  not written to.
- The two e2e specs (`prd06-phase2-portal`, `prd06-phase3-disputes`) run only against a live
  server, so they were not run here. Their only change is `request.get` → `request.post`, with the
  CSRF headers they already sent.

## Census SQL for prod (read-only; not run by this session)

```sql
-- R-157: members who were able to mint (any role outside owner/admin/manager).
SELECT role, count(*) FROM company_users
WHERE role NOT IN ('owner', 'admin', 'manager') GROUP BY role;

-- R-157: payment links that exist. portal_payment_links has no created_by column, so a
-- viewer-made link cannot be told apart from any other.
SELECT status, count(*), min(created_at), max(created_at) FROM portal_payment_links GROUP BY status;

-- R-155/R-157: live invoice tokens. A lost race leaves no trace, and no column records who
-- minted a token, so this count is the whole exposure.
SELECT count(*) FROM customer_invoices
WHERE portal_token IS NOT NULL AND status <> 'cancelled' AND deleted_at IS NULL;
```

## Follow-ups (not fixed here)

- The "share portal link" button still shows for a viewer. It now answers 403, and the page
  shows its generic "Failed to generate portal link". Hiding the button is a UI change and was
  not requested.
- The payment-link amount cap (should it be capped at the invoice balance?) is still Hein's
  decision (K-101).

## Migration / rollback

There is no migration. To roll back, revert the PR. The token column and the stored tokens are
untouched.
