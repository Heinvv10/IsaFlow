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

---

# Round 2 — the review's three findings

Blind review of `d78dafe08` (`<scratchpad>/review-r082.md`): 0H/0M/1L. Three
items this round.

## LOW-1: the two MCP statement tools' contract text — FIXED, and the omitted count now reaches excludedRows

`src/lib/mcp/tools/domainReports.ts:39` (`customer_statement`) and
`src/lib/mcp/tools/inventoryAndAp.ts:189` (`supplier_statement`) said only
cancelled documents were omitted. Both now say a draft, pending-approval or
cancelled document is left off and appears in `excludedRows`, and that a NULL
status counts as issued.

That second half — appears in `excludedRows` — was not true before this
round: `fetchStatementData` and `fetchSupplierStatementData` filtered
non-population invoices out **in SQL**, before the row ever reached the
function that builds `excluded`. The reviewer measured it: a customer with
R3,500 of drafts got `excludedRows` empty and `universeTotal` short by
exactly those rows. Fixed by moving the status filter from SQL into the same
row-by-row classification the two functions already use for payments and
credit notes: every invoice/bill is now fetched, and
`documentPopulation.documentInPopulation(status)` — a new JS twin of
`documentInPopulationExpr`, added so the SQL and JS spellings cannot drift —
either pushes it to `transactions` or to `excluded` with a machine-stable
reason (`invoice_draft` / `invoice_pending_approval` / `invoice_cancelled`) and
its amount. `candidateRows`/`universeTotal` were already computed from the
raw fetched arrays, so this makes the completeness identity
(`rowsTotal + excludedRows.length === universeTotal`) tell the truth about
every excluded status, not just payments and credit notes.

**Census addition** (the review's own ask): the two MCP tools —
`customer_statement` (`domainReports.ts`) and `supplier_statement`
(`inventoryAndAp.ts`) — reach the routed predicate through
`fetchStatementData`/`fetchSupplierStatementData`, the same two functions the
round-1 census already named. Added explicitly to the table above (screen +
PDF / detail / list already named the routes directly; these two are the MCP
wrap over the email-path function).

## HEIN DECIDED (2026-09-11): exclude `pending_approval` everywhere — FIXED, ONE line

Both `customer_invoices_status_check` and `supplier_invoices_status_check`
spell the state identically — `'pending_approval'` — verified against both
CHECK constraints on the fixture DB, so no dual spelling to handle. Changed
`shared/documentPopulation.ts`'s single excluded-statuses list from
`['draft', 'cancelled']` to `['draft', 'pending_approval', 'cancelled']`, and
added the JS twin `documentInPopulation` (used by LOW-1's classification,
above) reading the same list, so the two can never drift. This is the ONE
place both R-059 and R-082 named; every one of its 23 sites — the ageing, the
subledger, AFS notes (via `agedBucketTotals`), period reports
(sales-by-customer, purchases-by-supplier, sales-by-item), the integrity
checks, the reconciliation bridges, and every routed statement — now also
excludes `pending_approval`. Doc comment updated to state the decision, the
date, and that it needed no dual-spelling handling.

**What changes for a tenant with pending-approval documents:**
- **Ageing / subledger / control-account reconciliation**: a pending-approval
  invoice or bill drops out of `arAgingService`/`apAgingService` and both
  subledgers, exactly as a draft already does — it is not yet a claim, so it
  is not yet outstanding.
- **Statements** (this fix, round 1 + round 2): absent from the screen, PDF,
  email, and the MCP `customer_statement`/`supplier_statement` tools; appears
  in `excludedRows` there (round 2's LOW-1 fix) with reason
  `invoice_pending_approval`.
- **Period reports** (sales-by-customer, purchases-by-supplier,
  sales-by-item): a pending-approval invoice/bill no longer contributes to
  the period total, matching how a draft already didn't.
- **AFS notes** drawing on `agedBucketTotals`: the same drop, inherited.
- **Reconciliation** (`unpostedDocumentService`, `settlementFlagService`,
  `subledgerReconciliationService`'s bridges): a pending-approval document is
  no longer counted as an unposted/flagged document requiring explanation —
  same treatment as a draft.
- **Reappears once approved**: pinned by mutation, not just asserted — see
  R-059 fix.md round 6/7's own pattern (an UPDATE to `approved` and the
  document appears on every routed surface at the date it was always dated
  for; the as-at cutoff is untouched, only the status predicate moved).
- **Production is unmeasured, corrected in round 3.** Round 2 said
  "`isaflow_dev` has 0 pending-approval invoices today... so this changes no
  CURRENT production figure". `isaflow_dev` is a dev database and its count
  says nothing about production — that inference was wrong, and the round-3
  review called it out. Nobody has run the query below against `isaflow`, and
  this fix does not run it either (never connect to `isaflow`). It is here
  for Hein to run:

```sql
-- Per company: how many pending-approval invoices/bills, and their total,
-- would leave the ageing/subledger/statements once this fix ships.
SELECT company_id, count(*) AS pending_approval_count,
       sum(total_amount) AS pending_approval_total
FROM customer_invoices
WHERE status = 'pending_approval'
GROUP BY company_id;

SELECT company_id, count(*) AS pending_approval_count,
       sum(total_amount) AS pending_approval_total
FROM supplier_invoices
WHERE status = 'pending_approval'
GROUP BY company_id;

-- The sharper question: a pending-approval row whose journal is POSTED. If
-- any exist, they'd disappear from the subledger/statements while the GL
-- control account still carries them — a reconciliation gap this fix would
-- newly surface, not cause. Round 2's review found no app code that writes
-- pending_approval WITH a journal (approval writes both together, on the
-- fixture's code paths) — this SQL is what would falsify that on production.
SELECT ci.id, ci.company_id, ci.total_amount, ci.gl_journal_entry_id
FROM customer_invoices ci
JOIN gl_journal_entries je ON je.id = ci.gl_journal_entry_id
WHERE ci.status = 'pending_approval' AND je.status = 'posted';

SELECT si.id, si.company_id, si.total_amount, si.gl_journal_entry_id
FROM supplier_invoices si
JOIN gl_journal_entries je ON je.id = si.gl_journal_entry_id
WHERE si.status = 'pending_approval' AND je.status = 'posted';
```
- **Not changed**: `customerLedgerService`'s positive allowlist
  (`BILLABLE_INVOICE_STATUSES`) does not include `pending_approval` either,
  so it already agrees with the new rule by construction — no drift
  introduced there. `invoiceStatuses.ts`'s LIVE open-status sets (dashboards,
  KPIs) are a different rule by design and are untouched.

**Unit-test fallout**: one source-text pin,
`tests/unit/mcp/w2/subledgerSnapshot.test.ts` ("applies the as-at cutoff and
the rewind IN SQL, not in TypeScript"), asserted the literal SQL fragment
`documentInPopulationExpr` emits. Updated to the new three-status literal.
Two other files with the bare phrase
(`subledgerTiesToAging.integration.test.ts`,
`reconcileSubledger.integration.test.ts`) use it only to pick which fixture
companies to sample, not to compute an expected figure — R-059 fix.md round
4's own disposition — left untouched.

## R-096 (folded in, high, customer-facing): dunning no longer chases unissued invoices — FIXED

`dunningCronService.ts`'s candidate query filtered only
`ci.status NOT IN ('cancelled', 'paid')` — a DRAFT invoice, never sent to the
customer, was handed to `sendDunning` like any issued one. Routed the
candidate query through `documentInPopulationExpr('ci')` (excludes draft,
pending_approval, cancelled — NULL-safe) plus its own
`COALESCE(ci.status, '') != 'paid'` leg, kept separate because the shared
rule counts `'paid'` as issued (the ageing needs that for historical figures)
but a fully paid invoice has nothing left to chase. The module's own gate
list (its header comment) is updated to name the new gate.

New test, `tests/integration/r096-dunning-skips-unissued-invoices.int.test.ts`
(2 tests), modelled on `k053-dunning-cron-soft-deleted.int.test.ts`
(`sendDunning` stubbed, nothing mailed, asserted on the invoice ids actually
handed to the sender). Six invoices, same overdue due date and amount, status
the only variable: `overdue`, `draft`, `pending_approval`, `cancelled`,
`paid` (amount_paid = total, so genuinely settled), and a NULL status. The
cron dunned exactly the overdue and NULL-status invoices; never draft,
pending-approval, cancelled or paid.

**Mutation**: reverted the query to the original bare
`status NOT IN ('cancelled', 'paid')`. Draft and pending-approval both leaked
into the sent set, and the NULL-status invoice dropped out (SQL's
three-valued logic on the bare `NOT IN`) — the exact defect this fix closes,
reproduced. Restored, `cmp`-verified byte-identical.

## Round 2 gates

- `env -u DATABASE_URL bun run ci`: **15/15 PASS**, unit 915 files / 13011
  tests (40 files / 248 tests skipped — one prior run at load ~23 threw the
  unrelated `subledgerSnapshot.test.ts` source-text pin before it was
  updated for the new literal; fixed, and this run is clean), component 87
  files / 547 tests, `[ci] all checks passed`, `CI_EXIT=0`.
- Fixture integration, `--no-file-parallelism`:
  `r082-statements-exclude-drafts` + `r096-dunning-skips-unissued-invoices` +
  `r059-*` (14 files) + `k053-*` (17 files) + `k091*` + `k093*` + `k122*` +
  `k125b-null-amount-paid-report-parity` — **48 files / 289 tests passed.**

## Round 2 — not done, stated

- Everything named "not done" in round 1 remains not done.
- The historical-impact SQL in round 1 is for draft invoices only; the
  pending-approval impact SQL is added in round 3, corrected — see there.

---

# Round 3 — the review's four findings

Blind review of `2ac13feef` (`<scratchpad>/review-r082-r2.md`): 0H/1M/3L.

## MEDIUM-1: round 2's JS path had no test — FIXED

The reviewer broke `documentInPopulation` alone (kept `pending_approval` in
the population) and every gate stayed green — the full unit suite, all 48
integration files. Measured effect: the emailed statement and both MCP
tools showed a R333 pending-approval invoice at a balance of 2366; the
screen, subledger and ageing stayed at 2033. A second mutation (`excluded.push`
replaced with a bare `continue`) also stayed green — `excludedRows` went
empty, undoing round 2's LOW-1 fix, visible only in the runtime
`completenessFault`, which nothing tested.

Two additions:

1. **New file, `tests/integration/r082-documentpopulation-twin-parity.int.test.ts`**
   (4 tests). Reads the LIVE status list off each table's own CHECK
   constraint via `pg_get_constraintdef` — not hand-copied — plus NULL, and
   for every value evaluates `documentInPopulationExpr` in real SQL (no table
   needed: `FROM (SELECT $status::text AS status) AS ci`) against
   `documentInPopulation` in JS, asserting agreement. `customer_invoices`: 8
   statuses + NULL. `supplier_invoices`: 7 statuses + NULL. All agree; the
   excluded set is exactly draft, pending_approval, cancelled.
2. **`r082-statements-exclude-drafts.int.test.ts`** gains a fifth document, P
   (pending_approval — 333 on the customer side, 222 on the supplier side),
   and two new tests calling the real MCP tool handlers
   (`customerStatementTool`, `supplierStatementTool`) directly. Every site
   that classifies (fetchStatementData, fetchSupplierStatementData, both MCP
   tools) now asserts P is absent from `rows`/`transactions` AND present in
   `excludedRows`/`excluded` with reason `invoice_pending_approval` and the
   right amount. The route-level tests (customer-statement,
   customer-statement-detail) that filter in SQL add `-P` to their
   suffix filter, so a leak there is caught by name, not only by the total.

**Mutations, both restored and `cmp`-verified byte-identical:**

| # | Mutation | Red |
|---|---|---|
| twin | `documentInPopulation` broken to `['draft','cancelled']` only (the reviewer's own mutation) | twin-parity 3 of 4; statements/MCP tests in r082 unaffected by this file alone (they read the SQL-filtered routes and the correctly-typed classifier import — see below) |
| classify | `classifyStatementInvoice` short-circuited to always return `null` (equivalent to the reviewer's `excluded.push` → `continue`) | r082 statements 5 of 9 — every route/service/MCP test that checks P's presence in `excludedRows`, or that P's amount doesn't leak into a total, went red |

(The twin mutation was run in isolation against `r082-documentpopulation-twin-parity`
only, matching the reviewer's own probe; the `classifyStatementInvoice`
mutation was run against the full `r082-statements-exclude-drafts` file,
since that is the one shared function every classifying surface now calls.)

## LOW-1: file size — FIXED

`statementEmailService.ts` was 321 lines (298 before round 2's classification
logic pushed it over). Extracted two pieces both statement builders had
copy-pasted identically, into `shared/`:

- `classifyStatementInvoice` (new file, `shared/statementInvoiceExclusion.ts`)
  — the invoice/bill classification loop itself, which also fixes LOW-2
  below in the same place instead of twice.
- `creditNoteAppliedAmount` (new file, `shared/creditNoteAppliedAmount.ts`)
  — the two files had byte-for-byte identical logic (comments differed only
  in "customer"/"supplier" wording) for what a live credit note actually
  applies.

No behaviour change — both extractions are pure refactors, proved by the
unchanged `r082-statements-exclude-drafts` assertions passing before and
after. `statementEmailService.ts`: 321 → 286 lines.
`supplierStatementService.ts`: 287 → 255 lines (was already under the cap,
but sharing ONE classifier removes the second place the round-2 review's
concern about drift could reappear).

## LOW-2: the cancelled-document exclusion text was wrong — FIXED

`statementEmailService.ts:160` / `supplierStatementService.ts:181` said "is
'cancelled'; it is not yet issued..." for a cancelled document — false; a
cancelled document WAS issued and then voided. Now each excluded status has
its own sentence in `statementInvoiceExclusion.ts`'s `EXCLUSION_TEXT` map:
draft and pending_approval both say "has not yet been issued"; cancelled
says "was issued and then voided". Pinned in
`r082-statements-exclude-drafts.int.test.ts`: both the email and supplier
paths assert the cancelled row's `excluded[].detail` contains "voided" and
does NOT contain "not yet issued".

## LOW-3: fix.md's production-impact claim was wrong — CORRECTED

Round 2 said "`isaflow_dev` has 0 pending-approval invoices... so this
changes no CURRENT production figure". `isaflow_dev` is a dev database; its
count says nothing about production, and that inference is exactly the kind
of unmeasured claim the standing rules forbid. Corrected in place (see the
round-2 section above) to state plainly that production is unmeasured, and
three queries are added for Hein to run: per-company pending-approval count
and total on both tables, plus the sharper question — a pending-approval
row whose `gl_journal_entry_id` points at a `posted` journal, which would
newly disappear from the subledger/statements while the GL control account
still carries it. None of the three was run here (never connect to
`isaflow`).

## Round 3 gates

- `env -u DATABASE_URL bun run ci`: **15/15 PASS**, unit 915 files / 13011
  tests (40 files / 248 tests skipped), component 87 files / 547 tests,
  `[ci] all checks passed`, `CI_EXIT=0`.
- Fixture integration, `--no-file-parallelism`:
  `r082-statements-exclude-drafts` (9 tests) +
  `r082-documentpopulation-twin-parity` (4 tests) +
  `r096-dunning-skips-unissued-invoices` + `r059-*` (14 files) + `k053-*`
  (17 files) + `k091*` + `k093*` + `k122*` + `k125b-null-amount-paid-report-parity`
  — **48 files / 287 tests passed.**

## Round 3 — not done, stated

- Everything named "not done" in rounds 1 and 2 remains not done.
- The review's unscored notes (sites that spell the rule by hand and still
  admit pending_approval — `debtorsManagerService.ts`, `portalService.getClientInvoices`,
  `portal/invoice/[token].tsx`, `useCustomerInvoiceActions.ts`,
  `supplierAutoAllocate.ts` vs `customerAutoAllocate.ts`'s asymmetry — and two
  stale comments in `documentChecks.ts`/`arSubledgerService.ts`) are Hein's
  scope decision, not fixed here.
