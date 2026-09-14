# R-095 — customer portal statement and invoice list are broken

Branch: `fix/audit-r095-portal-statement`, from `origin/master` @ `7d708aac1`.

## Reproduction

`portalService.getClientInvoices` and `portalService.getClientStatement`
selected a `total` column from `customer_invoices` — the real column is
`total_amount` — and `getClientStatement` additionally filtered
`customer_payments` on `status = 'posted'`, a value the table's own CHECK
constraint (`draft`/`confirmed`/`reconciled`/`cancelled`) forbids. Both
defects were reproduced directly against the fixture as the first two `it`
blocks in
`tests/integration/r095-portal-statement-matches-inapp.int.test.ts`
("premise: the old query shape 500s" / "premise: 'posted' is not a legal
customer_payments status"), and by exercising the actual routes
(`pages/api/portal/statement.ts`, `pages/api/portal/invoices.ts`), which
both 500'd before the fix. This matches the register's claim and the finding
already logged by the R-082 fixer (see
`docs/audits/remediation/R-082/fix.md` and the header comment in
`tests/integration/r082-statements-exclude-drafts.int.test.ts`, which noted
this defect out of scope for that PR).

`getClientInvoices` also filtered `ci.status NOT IN ('draft', 'cancelled')`
directly, the same bare predicate R-082 fixed everywhere else: it admits
`pending_approval` and silently drops a NULL-status invoice via SQL's
three-valued logic.

## Root cause / class census

By CONSUMER — every reader of "what does a customer statement look like for
this customer" that exists in the repo:

| Consumer | Status | Population rule | Agrees with portal? |
|---|---|---|---|
| `pages/api/accounting/customer-statement.ts` (screen + PDF) | routed (R-082) | `documentInPopulationExpr` | **No — see below** |
| `pages/api/accounting/customer-statement-detail.ts` | routed (R-082) | `documentInPopulationExpr` | not compared (out of scope) |
| `statementEmailService.fetchStatementData` (emailed statement) | routed (R-082) | JS-side `classifyStatementInvoice`, same rule | **Yes — identical** |
| MCP `customer_statement` tool | routed (R-082) | shares `fetchStatementData`-equivalent classification | **Yes — identical** |
| `pages/api/portal/chat.ts` | **broken** — same defect class, missed in round 1's census | fixed here (round 2, M2) | Yes — now sources its balance from `fetchStatementData` directly |
| `portalService.getClientStatement` / `getClientInvoices` (portal statement + invoices) | **broken** — wrong columns, invalid status literal, unrouted `NOT IN` | fixed here | — (this is the portal) |

Four of six surfaces were already routed through the shared population rule
by R-082; the portal statement/invoices route and the portal chatbot were
both left broken because their routes 500'd before the rule even mattered.
Fixing the columns alone (without routing) would have re-created a further
parallel implementation of "what counts as a customer's balance" — exactly
the drift R-082 was written to close off.

**Round 1 review correction (M1 — was wrong in the first cut of this file):**
the portal does **not** match `customer-statement.ts` (the in-app screen).
That route is a genuinely different report from `fetchStatementData`/MCP:
it credits a receipt at its **allocated** figure rather than the full
receipt (`:117`), counts only `status = 'approved'` credit notes so an
`applied` one disappears (`:135`), and defaults to a one-year window with no
opening balance (`:72-73`), where `fetchStatementData` runs from inception.
Measured on the fixture: a customer with an invoice of 1000, an approved
credit note of 100, an applied note (total 300, applied 200), and a
confirmed receipt of 400 with 150 allocated shows a portal/email/MCP closing
balance of 300 and a screen `summary.balance` of 750. This is a real,
separate defect in the screen route, outside R-095's affected paths — Hein
is registering it separately (R-083 is already changing the credit-note
side of that gap) — so this fix does **not** touch
`customer-statement.ts`. Every claim in this file and in the test file's
title/comments now says "portal matches the email and MCP", never "matches
the in-app statement" unqualified.

## Fix

`src/modules/accounting/services/ar/portalService.ts`:

- `getClientInvoices`: `total` → `total_amount`; the bare
  `NOT IN ('draft', 'cancelled')` replaced with
  `documentInPopulationExpr('ci')` (same helper R-082 routed the other
  invoice-listing surfaces through).
- `getClientStatement`: the whole hand-rolled UNION ALL query replaced with a
  call to `statementEmailService.fetchStatementData(companyId, clientId,
  asOfDate)` — the same service the in-app emailed statement already uses.
  This is the single point of truth for "customer statement" transactions
  (invoices, payments, **and credit notes** — the old portal query omitted
  credit notes entirely, which would have overstated a customer's balance by
  any live credit note's value) and inherits R-082's classification rules for
  free. Returns `null` when the customer doesn't exist for that company
  (soft-deleted, or a token naming a customer outside its own company) —
  `pages/api/portal/statement.ts` now maps that to a 404 instead of the old
  code's `{ name: 'Unknown', email: '' }` fallback, which would have returned
  a statement (with a real balance) for a nonexistent/cross-company customer.

`pages/api/portal/statement.ts`: added the `null` → `notFound` branch above.

## Round 2 (blind review `review-r095-r1.md`, 2 MEDIUM / 3 LOW)

**M1 — census/claim correction.** See the census table and the note above:
fix.md and the test title previously claimed the portal matched the in-app
*screen*; corrected to say it matches the email/MCP surfaces, and the
screen's three differences are named and left alone (Hein's call to make
separately, tracked as its own register item).

**M2 — census gap: `pages/api/portal/chat.ts`.** Same `portal_session`
cookie, same defect class, missed by round 1's "consumer" census because
that census walked readers of the *statement*, not every route sharing the
session cookie. `chat.ts:57` selected `amount, customer_id` from
`customer_payments` — neither column exists (it's `total_amount` and
`client_id`; `customer_payments` has no `customer_id` column at all, unlike
`customer_invoices`) — a 500 on every call. `chat.ts:54-56` quoted the
customer a balance/overdue/open-count via a bare
`status NOT IN ('cancelled', 'draft', 'paid')`, unrouted through R-082's
shared rule (admits `pending_approval`, drops a NULL-status invoice).
Fixed: `outstandingBalance` now comes directly from `fetchStatementData` —
the same call the portal statement route makes — so the chatbot cannot
quote a different number than the statement the customer can also open.
`overdueAmount`/`openInvoices` are routed through `documentInPopulationExpr`
and now test the actual outstanding amount
(`total_amount - amount_paid > 0`) instead of a hand-rolled `'paid'`
exclusion, which is strictly more correct (a partially-paid invoice under
some other status was previously miscounted either way) and needs no
special-cased status literal. `lastPay` fixed to select real columns and to
only count a `confirmed`/`reconciled` payment as "last payment" (a draft
receipt settles nothing — same rule `fetchStatementData` already applies).

Redid the portal census over every route under `pages/api/portal/**`:
`auth.ts`, `chat.ts`, `invoices.ts`, `statement.ts` use the `portal_session`
cookie/JWT and read customer data scoped to it — these are the four this
fix (rounds 1+2) covers. `invoice/[token].ts`, `invoice/[token]/dispute.ts`,
`invoice/[token]/pdf.ts`, `invoice/generate.ts`, `payment-link.ts`,
`payments/paystack/{create,verify}.ts`, `pixel/[token].ts` use a wholly
different, per-invoice/per-link token (not the session cookie) — checked
each for the three specific defect signatures (nonexistent column, invalid
status literal, unrouted bare status `NOT IN`/`!=`) and found none: they
alias `total_amount AS total` correctly, use real statuses, and
`invoice/[token].ts`'s `status != 'cancelled'` is a single-document,
token-gated view (not a population/list query) rather than the ageing-style
population this fix's rule governs. No further defects of this class found;
not otherwise in scope.

**L3 — `asOf` validation and default timezone.** `pages/api/portal/statement.ts`
took `req.query.asOf` unvalidated, so `asOf=garbage` or a repeated
(array) `asOf` reached Postgres and 500'd instead of 400. Its default,
`new Date().toISOString().slice(0,10)`, rolls back a day between 00:00 and
02:00 SAST on this UTC+2 host — the exact defect `src/lib/fmtDate.ts`
documents for DB-sourced dates. Fixed: reject an array outright; validate a
single value against `/^\d{4}-\d{2}-\d{2}$/` plus a real `Date` parse (400 on
either failure); default via `asAtTodayStr()` (local calendar getters, the
same helper `getClientInvoices` already used for its soft-delete cutoff).

**L4 — a soft-deleted customer could still act.** `authenticatePortalUser`
didn't check `customers.deleted_at`, so a removed customer could still log
in and mint a fresh `portal_session`. `getClientInvoices` didn't check the
customer row at all, so a session minted *before* a delete (the JWT is
valid for 24h) could still list invoices, while the statement route (via
`fetchStatementData`'s own `deleted_at IS NULL` check) already 404'd for the
same customer — the two views disagreed on whether the account existed.
Fixed: `authenticatePortalUser`'s query gained `AND c.deleted_at IS NULL`;
`getClientInvoices` now does the same customer-existence + `deleted_at`
check `fetchStatementData` does, returning `null` (→ `pages/api/portal/invoices.ts`
now 404s) instead of an invoice list, matching the statement route exactly.

**L5 — missing test coverage for two already-load-bearing barriers.**
Added: (a) a live (`approved`) credit note fixture to the statement test —
round 1 found the suite passed 6/6 with credit notes filtered out of the
portal's `transactions` entirely, because no fixture ever exercised one;
the test now asserts the credit note's reference, its `credit` amount, and
that it lowers `closingBalance` to the correct figure, and a mutation
(filtering `credit_note` back out of the `.map()`) proved this red before
restoring. (b) a corrupted-row fixture on the invoice list — an invoice
whose `client_id` names customer A but whose `company_id` is company B's
(nothing in the schema prevents this; the two columns are independent FKs)
— to pin the invoice list's *own* `ci.company_id = companyId` predicate
specifically, independent of the L4 customer-existence pre-check (which
passes for this row, since customer A genuinely belongs to company A). A
mutation removing that inner predicate let the corrupted invoice leak
through; restored after confirming red.

## Tenant/IDOR scoping

The portal runs outside `withAuth` (no request-scoped transaction, no GUCs,
no RLS context) — every query in `fetchStatementData` and
`getClientInvoices` carries an explicit `AND company_id = $companyId`
predicate instead. `companyId` is never taken from the query string: it
comes from `session.companyId`, decoded from the `portal_session` JWT
(`arPortalJwt.ts`, `PORTAL_JWT_SECRET`, HS256, server-signed at login via
`authenticatePortalUser`'s `customers.company_id` join). The route further
requires `session.clientId === req.query.clientId` before calling the
service at all, so a customer cannot request another customer's statement
even inside the same company by editing `clientId` in the URL — verified by
mutation-testing that guard (removing it flips the cross-tenant probe from
403 to 404, i.e. the test still catches it, just via a different path;
restored byte-identically). A forged token naming a real customer of a
*different* company than the one in the token's own `companyId` claim finds
nothing, because `fetchStatementData`'s customer lookup is
`WHERE id = clientId AND company_id = companyId`.

## Mutations run (each observed red, then restored byte-identically)

Round 1:
1. Reverted `documentInPopulationExpr('ci')` back to
   `ci.status NOT IN ('draft', 'cancelled')` in `getClientInvoices` →
   "portal invoices route" test went red (pending_approval invoice
   `-P` appeared, NULL-status invoice `-N` disappeared).
2. Set `getClientStatement`'s `closingBalance` to a hardcoded `0` → "portal
   statement route" test went red (expected 800, got 0).
3. Removed the `session.clientId !== clientId` guard in
   `pages/api/portal/statement.ts` → cross-tenant probe test went red
   (403 expected, got 404 — the request no longer gets rejected at the
   guard, so it falls through to the company-scoped customer lookup, which
   still finds nothing for a genuinely cross-company clientId, proving the
   guard is a real, load-bearing check and not incidental).

Round 2:
4. Removed the customer-existence + `deleted_at` pre-check from
   `getClientInvoices` → both the "forged token ... sees nothing on
   statement or invoices" test AND the L4 soft-delete test went red (200
   instead of 404 in both cases).
5. Removed `AND c.deleted_at IS NULL` from `authenticatePortalUser`'s query
   → the L4 test went red (`after` login succeeded instead of returning
   `null`).
6. Removed `getClientInvoices`'s own `AND ci.company_id = ${companyId}::UUID`
   predicate (leaving only the pre-check) → the corrupted-row test went red
   (`-XCO`, company B's invoice against customer A, leaked into the list).
7. Filtered `credit_note` transactions out of `getClientStatement`'s
   `.map()` → the statement test went red (`-CN` missing from the
   transaction list).
8. Reverted `pages/api/portal/statement.ts`'s `asOf` handling to the
   unvalidated `(req.query.asOf as string) || new Date().toISOString().slice(0,10)`
   → the L3 validation test went red (500 instead of 400 on `asOf=garbage`).
9. Reverted `chat.ts`'s `lastPay` query to
   `SELECT amount, payment_date FROM customer_payments WHERE COALESCE(client_id, customer_id) = ...`
   → the M2 test went red (500 — `column "amount" does not exist`).

All nine restored via `git diff` verification against the intended patch
before commit.

## Gates

- `env -u DATABASE_URL bun run ci` (round 2, via `ci-slot.sh`) → `[ci] all
  checks passed` (exit 0); full production build succeeded, including
  `/api/portal/statement`, `/api/portal/invoices` and `/api/portal/chat`.
- Integration:
  `source <scratchpad>/fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/r095-portal-statement-matches-inapp.int.test.ts tests/integration/r082-statements-exclude-drafts.int.test.ts`
  → **2 files, 19 tests, all passed** (10 R-095 tests, up from 6 in round 1,
  covering M1's corrected claim, M2's chat.ts fix, L3's asOf validation, L4's
  soft-delete checks and L5's credit-note/cross-company-row pins + all 9
  pre-existing R-082 tests, confirming this fix does not disturb R-082's
  routing).

## Production impact SQL (for Hein — not run)

None required. This is a pure application-code fix; no data was ever
written incorrectly by these code paths (the routes have thrown a 500 on
every call since they were written, per the register's
`historicalDataImpact: "None on the ledger; the portal statement has never
rendered."`). No backfill, no migration.

To size how many customers were affected by the outage (register's
`processNotes` asks this), check web access logs for hits to
`/api/portal/statement` and `/api/portal/invoices` — e.g.:

```
grep -c '"path":"/api/portal/statement"' /var/log/isaflow/access.log*
```

(Not run — no access to production logs from this worktree, and the brief
forbids connecting to the production DB even read-only.)

## Residual risk

- Not browser-verified: the portal statement/invoice/chat surfaces consume
  these API routes, but I did not load the portal UI in a browser against a
  dev server, since the fix is API-only (no UI/component changes) and all
  three routes are already covered by real, DB-backed route-level
  integration tests exercising the exact request/response path the browser
  would hit.
- `getClientInvoices` is still its own query rather than routed through
  `fetchStatementData` (which returns statement *transactions*, not the
  richer invoice-list shape with `dueDate`/`amountPaid`/`balance` per
  invoice the portal UI needs) — it now shares the same
  `documentInPopulationExpr` population rule as every other invoice list,
  which is the part that matters for consistency; a further consolidation of
  the SQL projection itself is a nice-to-have, not a defect.
- `createPaymentLink` / `getPaymentLink` / `markPaymentLinkPaid` in the same
  file were not touched — out of scope for R-095, no register claim against
  them.
- The screen route (`customer-statement.ts`) still disagrees with the
  portal/email/MCP figure (M1) — deliberately untouched here; Hein is
  registering that gap separately, and R-083 already touches its
  credit-note handling.
- `pages/api/portal/invoice/[token].ts` and its siblings (per-invoice/link
  token auth, not the session cookie) were surveyed for this defect class
  only (M2's redone census) and found clean, but were not otherwise
  exercised by this PR's tests — no register claim against them exists.
