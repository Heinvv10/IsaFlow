# R-155, R-156, R-157, R-158 — fix (the K-101 portal follow-ups)

R-155..R-157 came out of the K-101 review (K-101/fix.md, Follow-ups). R-158 came out of this PR's
adversarial review (see Review round 1). One PR fixes all four, and this folder holds the evidence
for all four. The audit's K-276 (no CSRF on the portal mint and payment-link routes) is the CSRF
half of R-157, and its `canonicalItem` is now R-157.

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
  the button keeps working for owner/admin/manager.

## Tests

`tests/integration/r155-157-portal-mint-guards.int.test.ts` has 30 cases (28, plus the two-mint case from review round 1). They run through the
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
route, which is gone, so it has 24 cases. Two of them used to loop over both generate routes: "does
not hand out the token of an invoice in the user's other company" and "returns the token it
stored". They now cover `generate` only. The rest are unchanged.

Evidence:

- `red.int.log` (the original 28 cases): 14 fail on origin/master `6d1f4a488`: the generate race, both
  soft-deleted cases, both 405s, the viewer and no-CSRF cases for generate and payment-link, both
  minting GETs, the two non-UUID 500s, and the unknown-invoice 500.
- `green.log`, all on the review-round-2 head:
  - this suite: 30/30;
  - R-158: 20/20;
  - K-101: 24/24;
  - k122: 6/6;
  - k122b: 3/3;
  - r095: 7/7 + 7/7 + 8/8;
  - customer-ownership-fence-routes, on an `isaflow_test` clone: 32/32;
  - unit tests for `portalTokenService` + `dunningService`: 30/30.
- `mutations.log`: 38/38 mutants RED. M1–M34 ran on the round-1 head and M35–M38 on the round-2 head.
  That includes the R-158 lines: each UUID
  check (M23, M27) and its type check (M24, M28), each filter, the COALESCE, and null vs throw.
  Every changed source line was mutated:
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

## Review round 1

The general reviewer returned three LOWs, all about the docs; they are fixed here. The adversarial
reviewer returned SHIP with three LOWs.

- Test gap: the race test only covered a rival that had already committed. A new case runs two
  mints at once. Both requests read NULL and are held at the mint UPDATE until both have arrived,
  and the test asserts both return the one stored token. It is RED on master's `generate.ts`
  (`red.r1.int.log`), and mutant M1 (COALESCE removed) kills it.
- **A viewer can still READ an existing token** through `portal-link` GET. This is left as it is,
  and it is Hein's call. The viewer could already do this before the change: the invoice detail
  read already returns `payment_url`, and anyone holding the token can open the public page and
  file a dispute.
- Pre-existing, registered as **R-158** and fixed in this PR. These are the two other routes that
  create a portal payment link:
  - `customer-invoices/[id]/pay-now` and `payment-gateway` cast a non-UUID id and answered 500.
    `isUuidParam` now answers 400, including for a one-element array;
  - `pay-now` created a link for a cancelled or soft-deleted invoice. It now answers 404;
  - `enableOnlinePayment` had four problems:
    - it linked `ci.client_id` only, so a legacy invoice holding its customer in `customer_id`
      500'd on the NOT NULL column;
    - it had no status or `deleted_at` filter;
    - it had no balance filter;
    - it threw (500) for an unknown invoice.

    It now links `COALESCE(client_id, customer_id)`, refuses cancelled, deleted and fully paid
    invoices, and returns null, so the route answers 404.

  `tests/integration/r158-payment-link-creation-guards.int.test.ts` has 16 cases from round 1.
  Eleven of them fail on master code (`red.r1.int.log`). The five that pass on master:
  - pay-now: an open invoice, the legacy customer, an unknown invoice (already a 404), and a
    fully paid invoice (already a 400);
  - payment-gateway: an open invoice.

  The positive `pay-now` path mocks only the Paystack client.
- Round 2 (adversarial, LOW): the existing `withCsrf`/`withWriteAccess` guards on `pay-now` and
  `payment-gateway` had no committed test. Four cases were added (20 in all): a viewer and a
  request without the CSRF header both get 403, and no link, `payment_url` or
  `online_payment_enabled` is written. These guards were already on master, so the cases pass
  there. Mutants M35–M38 remove each guard, and each one fails its case.

## Browser proof (dev, 2026-09-29)

The check ran on a local `next dev` built from this branch (`6095cb320`), against `isaflow_dev`. The
QA user `reporting-qa@isaflow.dev` was signed in with a GoTrue `generate_link` + `email_otp`
session. Both runs clicked "Copy Portal Link" on an ISAFlow Demo invoice. Playwright recorded the
`/api/portal/invoice/generate` exchange.

- **As owner (INV0003562):** POST answered 200. `X-CSRF-Token` was sent. The page shows the minted
  link in "Portal link", and the token is stored on the invoice.
- **As viewer (INV0002619):** the QA user's Demo membership was set to `viewer` for this run only
  and restored to `owner` straight after. POST answered 403, "Your role (viewer) does not allow
  this action.". `X-CSRF-Token` was sent, so the refusal came from `withWriteAccess`. The page
  shows "Failed to generate portal link", and no token was stored.

The screenshots are not committed because the owner one shows a live dev token. Dev residue:
INV0003562 now carries a portal token.

## Review round 3 and `/review`

Both blind reviewers returned SHIP on `6095cb320`. `/review` (a fresh reviewer) returned APPROVED
with two LOWs:

- `payment-link.ts` composes `withAuth(withCsrf(withWriteAccess(...)))` with `withErrorHandler`
  outside `withAuth`, unlike `generate.ts`. This was not a bug, but a comment now says why;
- the viewer-reads-token point, which is already listed under Follow-ups.

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

-- R-158: live payment links on invoices that are cancelled, deleted or fully paid.
SELECT count(*) FROM portal_payment_links l JOIN customer_invoices ci ON ci.id = l.invoice_id
WHERE l.status = 'active'
  AND (ci.status = 'cancelled' OR ci.deleted_at IS NOT NULL
       OR ci.total_amount - COALESCE(ci.amount_paid, 0) <= 0);
```

## Follow-ups (not fixed here)

- The "share portal link" button still shows for a viewer. It now answers 403, and the page
  shows its generic "Failed to generate portal link". Hiding the button is a UI change and was
  not requested.
- A viewer can read an existing token through `portal-link` GET (see review round 1). This is
  Hein's decision.
- The payment-link amount cap (should it be capped at the invoice balance?) is still Hein's
  decision (K-101).

## Migration / rollback

There is no migration. To roll back, revert the PR. The token column and the stored tokens are
untouched.
