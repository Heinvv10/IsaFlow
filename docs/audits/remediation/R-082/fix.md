# R-082 — customer and supplier statements exclude drafts

**Decision (Hein, 2026-09-11):** statements must not show draft invoices/bills.
Fix: route every statement query through the shared rule R-059 round 6 built —
`shared/documentPopulation.documentInPopulationExpr(alias)` — instead of each
site's own bare spelling, which kept drafts and (via SQL's three-valued logic)
silently dropped a NULL-status row too.

## Census — starting from R-059 round 6/7's own table

R-059 fix.md round 6 (commit `9f0ee2d3f`) and round 7 (`fc1febb7b`) already
census'd every site claiming the ageing's population, by table and by claim,
and deliberately left the statement/portal bucket unrouted pending this
decision. That table is the starting point here; round 9 (`ad7d8f1a1`) had
already routed the two remaining supplier-side siblings (statement-recon match
candidates, statement-detail, statement-balances). This round routes the rest,
and re-disposes every site the earlier census put in the R-082 bucket:

| Site | Disposition |
|---|---|
| `pages/api/accounting/customer-statement.ts` (screen + PDF) — 2 predicates | **ROUTED** |
| `pages/api/accounting/customer-statement-detail.ts` — 2 predicates | **ROUTED** |
| `pages/api/accounting/customer-statements.ts` (balance summary list) | **ROUTED** |
| `src/modules/accounting/services/ar/statementEmailService.ts` (`fetchStatementData`, called by `sendStatementEmail` — the actual EMAIL body, and by `customer-statements-send.ts` / `statement-bulk-email.ts`) | **ROUTED** |
| `src/modules/accounting/services/ap/supplierStatementService.ts` (`fetchSupplierStatementData`, called by the MCP `inventoryAndAp` tool) | **ROUTED** |
| `src/modules/accounting/services/ar/portalService.ts` `getClientStatement` (`/api/portal/statement`) | **ROUTED** (status predicate), but **NOT exercised** — see below |
| `supplierStatementBalancesService.ts`, `pages/api/accounting/supplier-statement-detail.ts`, `capture/supplierStatementReconDb.ts` | already routed, R-059 rounds 6/7/9 — unchanged here |
| `customerLedgerService.ts` ("Reports > Customer Ledger") | **TABLED.** It deliberately uses a positive allowlist (`BILLABLE_INVOICE_STATUSES`), not the bare/shared negative-list spelling, for a different reason (fail-closed against a future status) — R-059 round 6's own disposition. It is a separate report page, not a statement Hein named, and changing its allowlist is a second decision this round does not make. |
| `portalService.getClientInvoices` (`/api/portal/invoices`) | **TABLED.** An invoice list, not a statement. Shares the same pre-existing column bug as `getClientStatement` below — not fixed here (see finding). |
| `portal/chat`, `portal/invoice/[token]`, `portal/invoice/generate`, `portalTokenService` | **TABLED.** Single-invoice views/tokens, not statements — out of R-082's named scope. |

## New finding — `portalService.getClientStatement` is pre-existing broken, unrelated to R-082

While routing `getClientStatement`'s status predicate I found its SELECT
list references columns that do not exist: `customer_invoices.total`
(the column is `total_amount`) and `customer_payments.reference` (the column
is `bank_reference` or `payment_number`), and it filters payments on
`status = 'posted'`, a value `customer_payments_status_check` forbids
(`draft`/`confirmed`/`reconciled`/`cancelled` only). `/api/portal/statement`
throws on every call today — measured by running the real function against
the fixture DB, not assumed. This is unrelated to R-082 (a column/status typo,
not a population rule) and touches customer-facing portal code, so it is
**registered, not fixed here** — flagging it to the register is the
orchestrator's call, not mine. `getClientInvoices` (`/api/portal/invoices`)
shares the `total` column bug.

## Guards fail both ways — pinned in `tests/integration/r082-statements-exclude-drafts.int.test.ts`

Every routed surface gets the same four documents: an **A**pproved one
(unchanged, must still appear), a **D**raft one (must never appear — the
fix), a **N**ULL-status one (must still appear, per the shared rule — this is
what "the bare spelling" silently dropped), and a **C**ancelled one (must stay
out, unchanged). 7 tests, one assertion each on the real route/service:

- `customer-statement` route — transactions and `summary.totalInvoiced`
- `customer-statement-detail` route — same
- `customer-statements` route — the customer's row in the balance list
- `statementEmailService.fetchStatementData` — the data the email is built from
- `sendStatementEmail` — the actual emailed HTML (email mocked with
  `vi.doMock`), asserting the rendered body contains A and N and never D
- `supplierStatementService.fetchSupplierStatementData` — mirror on the AP side

## Mutation-proof

One mutation of the shared helper — `documentInPopulationExpr` back to the
old bare `${alias}.status != 'cancelled'` — turned **6 of 7** tests red (the
7th is the fixture premise, which does not touch the predicate and correctly
stayed green). Restored, `cmp`-verified byte-identical against the file as
read from `git show` before the mutation.

## Opening balance / footing

None of the routed surfaces carries a separate brought-forward balance field:
`customer-statement`/`customer-statement-detail` compute `summary.balance`
from a SQL aggregate using the *same* routed predicate as the row list, so
totals foot with the transaction list by construction (same WHERE, same
alias). `statementEmailService`/`supplierStatementService` compute the running
balance by summing the (now-routed) fetched rows directly — no separate
aggregate to disagree with. `portalService.getClientStatement` hardcodes
`openingBalance: 0` (full-history statement, no windowing) — unaffected by
this fix.

## Impact — for Hein, NOT run against production

Count of currently-open (not paid off, not cancelled) draft invoices/bills
per customer/supplier that a statement would have shown before this fix,
i.e. what changes once this ships. Written for someone with production
access to run; **not executed here** (rule: never connect to `isaflow`).

```sql
-- Customer side: draft invoices that would vanish from a statement drawn today.
SELECT count(*) AS draft_invoices_on_statements,
       count(DISTINCT COALESCE(client_id, customer_id)) AS customers_affected,
       sum(total_amount) AS draft_total_amount
FROM customer_invoices
WHERE status = 'draft';

-- Supplier side: draft bills that would vanish from a statement drawn today.
SELECT count(*) AS draft_bills_on_statements,
       count(DISTINCT supplier_id) AS suppliers_affected,
       sum(total_amount) AS draft_total_amount
FROM supplier_invoices
WHERE status = 'draft';
```

`historicalDataImpact` in the backlog entry ("count statements sent while the
customer had draft invoices") needs a `statement_email_log` or equivalent —
grep found no such table, so that count cannot be produced from the schema at
all; the two queries above are the closest available proxy (current draft
exposure, not historical sends).

## Gates

- `env -u DATABASE_URL bun run ci`: **15/15 PASS**, unit 915 files / 13011
  tests (40 files / 248 tests skipped), component 87 files / 547 tests,
  `[ci] all checks passed`, `CI_EXIT=0`. (One run at load 22.9 threw a single
  unrelated component-test failure — `ReportPageDrillDimensions.test.tsx`,
  income-statement business-unit drill — which passed standalone and passed
  again in a clean full run at load 9.7; not counted, consistent with the
  parallel-agent flakiness the brief warns about.)
- Fixture integration, `--no-file-parallelism`:
  `tests/integration/r082-statements-exclude-drafts.int.test.ts` +
  `r059-*.int.test.ts` (14 files) + `k053-*.int.test.ts` (17 files) —
  **32 files / 180 tests passed.**

## Not done, stated

- `portalService.getClientStatement`'s pre-existing column/status bugs
  (above) — a new finding, not R-082's.
- `customerLedgerService`'s allowlist parity with the now-routed statements —
  tabled, a second decision.
- R-083 (funds population NULL-unsafety) and R-084/R-086/R-087, named in
  R-059 fix.md, remain untouched — out of this fix's scope.
