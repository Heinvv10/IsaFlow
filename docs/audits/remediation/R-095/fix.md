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

| Consumer | Status | Population rule |
|---|---|---|
| `pages/api/accounting/customer-statement.ts` (screen + PDF) | routed (R-082) | `documentInPopulationExpr` |
| `pages/api/accounting/customer-statement-detail.ts` | routed (R-082) | `documentInPopulationExpr` |
| `statementEmailService.fetchStatementData` (emailed statement) | routed (R-082) | JS-side `classifyStatementInvoice`, same rule |
| MCP `customer_statement` tool | routed (R-082) | shares `fetchStatementData`-equivalent classification |
| `portalService.getClientStatement` / `getClientInvoices` (portal) | **broken** — wrong columns, invalid status literal, unrouted `NOT IN` | fixed here |

Four of five surfaces were already routed through the shared population rule
by R-082; the portal was the one left broken because its route 500'd before
the rule even mattered. Fixing the columns alone (without routing) would
have re-created a SIXTH parallel implementation of "what counts as a
customer's balance" — exactly the drift R-082 was written to close off.

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

All three restored via `git diff` verification against the original patch
before commit.

## Gates

- `env -u DATABASE_URL bun run ci` → `[ci] all checks passed` (exit 0);
  full production build succeeded, including `/api/portal/statement` and
  `/api/portal/invoices` routes.
- Integration:
  `source <scratchpad>/fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/r095-portal-statement-matches-inapp.int.test.ts tests/integration/r082-statements-exclude-drafts.int.test.ts`
  → **2 files, 15 tests, all passed** (6 new R-095 tests + all 9 pre-existing
  R-082 tests, confirming this fix does not disturb R-082's routing).

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

- Not browser-verified: the portal statement/invoice pages consume these
  API routes, but I did not load the portal UI in a browser against a dev
  server, since the fix is API-only (no UI/component changes) and the two
  routes are already covered by real, DB-backed route-level integration
  tests exercising the exact request/response path the browser would hit.
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
