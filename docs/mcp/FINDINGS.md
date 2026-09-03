# Assurance programme — findings register

Every finding surfaced while building the MCP assurance endpoints, with what has
actually been done about it. Started 2026-09-03.

**Why this file exists.** Findings were accumulating in session messages between
workstreams, which is where they evaporate. A finding that is not written down
did not happen, and this programme's entire premise is that a system should be
judged on what it can prove.

**Status vocabulary — read this before using the table.**

| Status | Meaning |
|---|---|
| `FIXED` | Code changed and merged. |
| `FIXING` | Code change in flight in a named workstream. |
| `REPORTED` | Confirmed, deliberately NOT fixed here. Owned by someone else, or out of scope. |
| `OPEN` | Confirmed, nobody owns it yet. **These need a decision.** |
| `UNVERIFIED` | Claimed but not yet re-derived. Do not act on it. |

**Two standing scope rules** decided by Hein on 2026-09-03:

1. **Correcting the books is out of scope and happens after.** We build the
   endpoint that FINDS the problem. Every data correction is a separate decision
   with its own approval.
2. **Do not extend the write path.** The value is in read and assurance
   endpoints. The write path already works and the books are still wrong.

---

## A. The specification itself is unreliable

`docs/mcp/isaflow-mcp-endpoint-audit-2026-09-03.md` was written from outside the
codebase and several of its figures came from a single agent's query. **Ten of
its claims have now been corrected.** Treat its numbers as leads and re-derive
anything used as an acceptance criterion — a check tuned to reproduce a wrong
figure passes review and fails in production.

| # | Spec claim | Actual | Status |
|---|---|---|---|
| A1 | Cash application missing | Exists and works — `receiptMatchService`, `customerPaymentAllocationService`. MCP cannot reach it | REPORTED |
| A2 | Payroll absent / "no payroll process" | Real PAYE/UIF/SDL/ETI engines; `payrollJournalPostingService` posts a guarded journal | REPORTED |
| A3 | `settle_by_contra` needs building | WRAP — `bank_account_id` is a plain FK to `gl_accounts` with no subtype check; only the *labelling* is missing | FIXING (W1) |
| A4 | `list_unapplied_receipts` "exists as a UI report" | Does not exist. No occurrence of "unapplied" in the codebase | FIXING (W1) |
| A5 | 55 prior periods open | **56** on Brightsphere; 20 on Velocity | REPORTED |
| A6 | Every 2027 period closed | **Brightsphere only.** Velocity's 2027 is fully open — the two companies need opposite corrections | REPORTED |
| A7 | Nothing ever reconciled, both companies | True of those two; false system-wide — 2 reconciliations exist elsewhere | REPORTED |
| A8 | GL bank overstated R5.87m | Does not reproduce. R2,439,742.35 (VF) + R6,501,755.10 (BS) = R8.94m | UNVERIFIED — sign convention being checked |
| A9 | Payroll GL "deactivated and empty" | Deactivated on **Brightsphere only**; Velocity's five are active. Both empty | REPORTED |
| A10 | Budgets are a wrap | `budgetService` has **never executed** — see B15 | FIXING (W6) |
| A11 | 4,300 agent postings indistinguishable from a human's | Wrong in both directions. Velocity **6,891 of 7,335 provably agent** and unmentioned by the spec; Brightsphere **2,287 provably agent, 2,592 unprovable either way** | REPORTED |
| A12 | `apply_receipt_to_invoice` is a wrap | EXTEND + fix — the underlying route carried four defects incl. B20 | FIXED (W1) |

---

## A-live. Verified against the live Velocity Fibre books over MCP, 2026-09-03

Definition-of-done item 3, finally executable: a live connector to Velocity
Fibre. Every figure below came from the production MCP connection, not from the
database and not from the audit.

**`trial_balance` is FIXED and deployed. It now returns 74 accounts, not 7.**
Totals computed by hand from the response: R158,946,486.95 debit, R158,946,486.95
credit, **difference R0.00**. The audit's headline live evidence no longer holds,
and this is the first figure in the programme that can be signed.

**But the tool still cannot say so.** The response carries no `totalDebits`, no
`totalCredits`, no `difference`, no `balanced` and no `accountCount` — the service
computes all five and none is wired to MCP. An agent reading it cannot answer the
one question a trial balance exists to answer. That is W2's remaining scope.

**`aged_debtors` is unchanged and the audit's claim is exact.** Ten rows, no
total, no `rowsTotal`, no `truncated`, no envelope. Total (summed by hand):
**R63,133,371.78** — matching the audit's R63.1m.

### "What are we owed?" has three defensible answers, R35.2m apart

| | |
|---|---|
| Aged debtors total | R63,133,371.78 |
| `1120 Accounts Receivable` | R27,924,289.10 |
| `SYS-7 Trade Receivables` | R32,704,547.38 |
| both control accounts combined | R60,628,836.48 |

| reconciling question | gap |
|---|---|
| aged vs `1120` alone | **R35,209,082.68** |
| aged vs `SYS-7` alone | **R30,428,824.40** |
| aged vs both combined | **R2,504,535.30** |

All three are defensible, all three are different, and nothing in the schema says
which is right. This is B3 demonstrated on live production data, and it is why
`ar.control.v1` is deliberately unowned. The same holds on the payables side:
`2110` at R7,925,176.42 beside `SYS-8 Trade Payables` at R37,703,241.94.

### Three more things visible on the face of the live trial balance

- **`SYS-9 VAT Payable` is a liability carrying a DEBIT of R4,917,814.24** — B36,
  the input tax on a NULL-subtype account that drops out of the VAT201 entirely.
  It is in plain sight and no report was reading it.
- **Sixteen accounts carry a balance on the wrong side for their type.** Thirteen
  are paycards — asset accounts in credit. `49844679 Loan - B Oosthuizen` is a
  liability in debit. And `RE-BF` shows retained earnings as a **debit of
  R39,247,376.29**: accumulated losses of R39.2m, against R51.9m of revenue and a
  R45m Populace loan.
- **`49775627 Unallocated Expense` holds R5,742,472.04.**

---

## A-live-2. The shipped endpoints, run against the live books, 2026-09-03

Definition-of-done item 3 for W1 and W5, satisfied after the deploy of
`a2bb7ff7`. Every figure below is the endpoint's own output from the production
MCP connection.

### `list_unapplied_receipts` reproduces its own finding

```
totalUnapplied  R37,050,347.68   36 receipts
origins.agent   R37,050,347.68   36 receipts   100%
agent_tools     mcp:bulk_allocate_bank_transactions:v1
```

The endpoint built to find B28 returns B28's figure exactly, attributes all of it
to one tool, and says in its own description that the balance is still growing
and why. `not_stamped_as_agent` and `no_journal` are both zero here, and are
reported separately rather than folded into a human bucket.

### `audit_trail` admits the gap rather than papering over it

```
rowsTotal 9   attribution: recorded 0, derived 9   (all agent)
```

Correct: nothing has posted through the new code path since the deploy, so
nothing is yet a recorded fact. An endpoint reporting `recorded: 0` on its first
run is the design working — the alternative is an attribution that looks
authoritative and is inferred.

**Note the selection semantics.** It selects by ENTRY date, not by when the tool
ran, so the 842 `bulk_allocate` journals written today do not appear in a
1–3 September window — they carry their bank transactions' dates. Correct, and
documented, but it reads as a bug if unexpected.

### The R10,000 audit test has an answer, and it is zero

```
transactions_in_scope        1,217
transactions_with_a_document     0
```

**Not "few". Zero.** Over the whole of 2026 to date on Velocity Fibre, every one
of 1,217 transactions above R10,000 has nothing attached. The largest are two
**R6,000,000** Fibertime credits and a **R4,500,000** transfer, none carrying so
much as a reference.

The specification called this test "currently unanswerable". It is answerable
now, and `transactions_in_scope` / `transactions_with_a_document` size the
exposure rather than merely listing rows — which is the difference between a
report and a finding.

---

## A-live-3. `reconcile_subledger`, re-derived against production after the W2 fixes, 2026-09-03

Every figure below came from running `reconcileSubledger` read-only against the
production `isaflow` database. **`unexplainedDifference` is 0.00 on every
company, both roles, at every date tested** — the difference is fully
decomposed into named items carrying document ids, which is the requirement.

### Four things the endpoint was wrong about, and what changed

**1. `agedTotal` was a second opinion about a figure that already had an owner.**
It was recomputed from the reconciler's own snapshot. At today's date on
Velocity it read **R63,133,371.78** against the aging report's
**R75,864,129.21** — a gap of exactly **R12,730,757.43**, the invoices with no
due date. The reconciliation named that gap `unageable_document`: a claim that
the aged report drops them. True before #303; since then it ages them from
`invoice_date`. **R12.7m of Velocity AR and R1,058,000 of Brightsphere were
attributed to a mechanism that had been fixed**, and nothing could go red
because both sides of the comparison came from the same snapshot. `agedTotal`
now comes from `getARAging` / `getAPAging` and ties to them to the cent on every
company and date. `unageable_document` is deleted.

> The R63,133,371.78 in section A-live is the **deployed** aged report, which
> predates #306. It matched the old recomputation and not master. Both numbers
> were right about different code.

**2. `as_at` moved only one side.** The subledger readers read the current
`amount_paid` with no document-date cutoff, so `subledgerTotal` was frozen at
today while `controlAccountBalance` correctly moved. At 2025-12-31 Velocity AR
reported today's R75,864,129.21 against a control balance of **−R6,132,241.61**
and closed the R81,996,370.82 gap with a single `document_after_as_at` item of
**R72,867,375.59**. The arithmetic added up and answered a question nobody
asked. Both readers now use `shared/agingRewind.ts` — master's rewind, with its
four documented limitations — and the aging report's population and cutoff.
`afterAsAt` and `document_after_as_at` are gone with it: a document raised after
the reporting date is not in the subledger at that date, and one whose JOURNAL
is later is reported as `document_not_on_control_account`, which is what it is.

**3. `SYS-9 VAT Payable` was being adopted as an AP control account.** Subtype
NULL, type `liability`, touched by **356** Velocity supplier-invoice journals —
so `excludeSubtypes`, which matches on `vat_output`, could not exclude it. It
brought **−R4,917,814.24** into the control balance and the reconciliation then
"explained" exactly **+R4,917,814.24** with a 356-document
`document_not_on_control_account` item. Every number was internally consistent
and the account was the input-tax leg of a bill (this is B36 arriving through a
second door). The rule that now excludes it uses no account name: **a control
account is moved in its OWN direction by the documents that create the
balance** — a receivable is net debited by invoices, a payable net credited by
bills. It is applied only where there IS invoice movement, so Brightsphere's
account 1120 — subtype NULL, found solely through one R10,000 receipt — is still
kept. That row is why the posting arm exists.

**4. 397 bills flagged settled were visible only as an amount.** Confirmed
current: **397 Velocity bills, R16,151,543.00 outstanding, every one at
`amount_paid = 0.00`, no `payment_allocations` row, no `supplier_payments`
row.** `recordPaymentMatch` sets the flag from
`amount_paid + allocatedAmount`; it never writes `amount_paid`. Their cash IS on
the control account — **1,090 `auto_supplier_payment` journals move Velocity's
AP control by −R61,115,350.09 with no `supplier_payments` row behind any of
them** — so the money is already counted once as `posting_with_no_document`, and
a second item would double-count it. It is reported as `settlementFlagged`,
outside `reconcilingItems` where it cannot enter the arithmetic: an
ATTRIBUTION of part of a difference, not an addition to it.

### The books, decomposed (as at 2026-09-03)

| | control | subledger | aged | difference | residual |
|---|---|---|---|---|---|
| Velocity AR | R59,959,914.39 (`1120`+`SYS-7`) | R75,864,129.21 | R75,864,129.21 | R15,904,214.82 | **R0.00** |
| Velocity AP | R45,628,418.36 (`2110`+`SYS-8`) | R106,743,768.45 | R106,743,768.45 | R61,115,350.09 | **R0.00** |
| Brightsphere AR | R11,581,623.60 (`1101`+`1120`) | R14,272,647.60 | R14,272,647.60 | R2,691,024.00 | **R0.00** |
| Brightsphere AP | R613,641.77 (`2001`+`2110`) | R613,641.77 | R613,641.77 | R0.00 | **R0.00** |

Velocity AR decomposes to `unapplied_receipt` R37,719,269.77 (39 payment
documents), `posting_with_no_document` −R1,841,265.00 (4 journals) and
`document_not_on_control_account` −R19,973,789.95 (46 invoices). Velocity AP
decomposes to one item: `posting_with_no_document` R61,115,350.09 over 1,090
journals, of which R16,151,543.00 is attributed to the 397 flagged bills.
Brightsphere AR is `unapplied_receipt` R2,691,024.00 over 37 payments, plus an
offsetting R28,750 pair.

The **`aged_to_subledger` bridge is empty on every production company**: once
the aged total is read from the aged report rather than recomputed, the aged
report and the subledger agree exactly. No open disputes and no unallocated
credit notes exist on these books.

### Figures re-derived, and what moved

| figure | section A-live | now | note |
|---|---|---|---|
| Aged debtors total | R63,133,371.78 | R75,864,129.21 | A-live sampled the DEPLOYED aging report; master's includes null-due-date invoices |
| `1120 Accounts Receivable` | R27,924,289.10 | **R27,255,367.01** | moved R668,922.09 overnight — the bulk-allocating agent |
| `SYS-7 Trade Receivables` | R32,704,547.38 | R32,704,547.38 | unchanged |
| `list_unapplied_receipts` | R37,050,347.68 / 36 | **R37,719,269.77 / 39** | same R668,922.09, same 3 receipts |
| Velocity AP control | R7,925,176.42 + R37,703,241.94 | R45,628,418.36 | `SYS-9`'s −R4,917,814.24 correctly excluded |

`getUnappliedReceipts`' definition and `reconcile_subledger`'s were computed
over the same rows in one query and agree **to the cent**: 39 receipts,
R37,719,269.77, with no receipt lacking a journal and none whose control posting
differs from the receipt total. The two tools reconcile.

### `general_ledger`, run against the live Velocity books

The whole posted ledger, unfiltered, over 2020-01-01 → 2026-12-31:
**21,871 lines across 111 accounts, R519,723,273.19 debit and R519,723,273.19
credit, `balanced: true`.** Paged at 1,000 a call it took 22 pages and served
exactly 21,871 distinct lines — every line once, no envelope fault.

Two things that had to be got right and were not, first time round:

- The keyset carried `created_at` through a JS `Date`, which truncates
  microseconds to milliseconds. Paging Brightsphere's ledger then returned
  **10,603 lines where 10,460 exist** — duplicates at page boundaries, which is
  the one place nobody looks. The cursor now carries the timestamp at
  microsecond precision as text.
- `runningBalance` omitted the account's opening balance. Invisible over a
  window that starts before the first journal, because every opening balance is
  then zero — the same shape as the `trial_balance` defect, a period-movement
  listing wearing a ledger's name. The DB-gated case now starts mid-history and
  requires a non-zero opening.

`source: 'manual'` returns **zero lines on Velocity**: nothing in that ledger
was posted by hand.

### `balance_sheet` v2: two production companies carry R0.00 of posted equity

The second equity figure was never independent of the first, and it took
running it to see that. `getBalanceSheet` computes retained earnings as revenue
less expenses to the date and INJECTS it into the equity section, so
`totalEquity` equals assets less liabilities **by construction**. Reporting the
two beside each other agreed to the cent on all three production companies and
read as a clean set of books.

Querying the equity ACCOUNTS directly, as at 2026-09-03:

| | assets − liabilities | POSTED equity | derived retained earnings |
|---|---|---|---|
| Brightsphere | R8,394,848.60 | **R0.00** | R8,394,848.60 |
| Velocity Fibre | −R34,816,224.89 | **R0.00** | −R34,816,224.89 |
| ISAFlow Demo | R39,893,316.26 | R695,000.00 | R39,198,316.26 |

**Two of the three companies have never posted a cent to an equity account.**
Every rand of their equity is profit that no year-end close has moved out of the
revenue and expense accounts. The spec's "R8.46m retained-earnings plug" is
close to Brightsphere's figure and understates the shape of it: this is not one
suspect balance, it is the entire equity section on two companies.

`equity.ledger.v1` is now owned by `reports/balanceSheetService#getEquityBases`
— deliberately NOT `getBalanceSheet`, whose `totalEquity` is the residual
wearing the ledger's name. The identity a caller can check is
`assets − liabilities = postedEquity + retainedEarningsDerived`, and a DB-gated
test asserts it on real books along with the property that `totalEquity` equals
the residual, so the reason the second figure had to be built cannot quietly
stop being true.

Not built, and worth a decision: **how much of that derived profit belongs to
CLOSED prior years.** The plug for the current year is ordinary — it is what a
year-end close will post. The plug for years already ended is a close that never
ran, and separating the two needs the fiscal-year basis
(`gl/fiscalYearBasis.ts`). That is the figure that would say how many year-ends
are outstanding and for how much.

### `aged_debtors` / `aged_creditors` v2: the totals, and a 262-supplier report that served 10

The audit's finding was exact — ten rows, no total, no `rowsTotal`, no
`truncated`, no envelope — and it understated the paging half. Run with the
totals, as at 2026-09-03:

| | total | entities | bucket sum ties |
|---|---|---|---|
| Velocity AR | R75,864,129.21 | 10 | yes |
| Velocity AP | R106,743,768.45 | **262** | yes |
| Brightsphere AR | R14,272,647.60 | 8 | yes |
| Brightsphere AP | R613,641.77 | 5 | yes |

**Velocity's aged creditors has 262 suppliers.** The old tool returned every one
of them with no total and no `truncated`, so a reader had no way to know whether
they had the whole book. v2 pages at 200 and says `truncated: true` with
`rowsTotal: 262`, and the totals are computed over all 262 before the page is
cut.

The three tools now agree with each other on these books, which is the first
time that can be said: `aged_debtors`' R75,864,129.21 is exactly
`reconcile_subledger`'s `agedTotal` AND its `subledgerTotal` for Velocity AR, and
the `unappliedReceipts` figures it reports — 39 receipts / R37,719,269.77 on
Velocity, 37 / R2,691,024.00 on Brightsphere — match `reconcile_subledger`'s
`unapplied_receipt` item to the cent on both companies.

The audit's R63,133,371.78 is the **deployed** aged debtors report, which
predates #306. Master's is R75,864,129.21, the difference being the null-due-date
invoices #303 stopped dropping.

`unappliedReceipts` is NAMED and never netted off the aged total: netting it
would invent a figure no report owns. `agedFromInvoiceDate` reports the invoices
whose bucket is derived from an invoice date because they carry no due date —
they ARE in the buckets, and it is deliberately not `excludedRows`, because
nothing is excluded any more and saying otherwise would misdescribe the fix.

### The income-statement comparative was a rolling window, in the UI

Not in the service, which takes explicit dates.
`pages/accounting/reports/income-statement.tsx` computed the comparative in
milliseconds:

```
const durationMs = end.getTime() - start.getTime();
const priorEnd   = new Date(start.getTime() - 1);
const priorStart = new Date(priorEnd.getTime() - durationMs);
params.set('compare_start', priorStart.toISOString().split('T')[0]);
```

Two defects in four lines. March is 31 days, so a month-on-month comparative
compares against **29 January – 28 February** and February never appears as
itself. And `toISOString()` renders in UTC on a UTC+2 host — the defect class
this repo has been bitten by repeatedly.

`reports/priorPeriod.ts` replaces it: pure, `'YYYY-MM-DD'` in and out, no `Date`
constructed anywhere. Whole calendar months map to the same number of whole
calendar months before them; anything else falls back to the preceding window of
equal length. `priorYearPeriod` clamps 29 February to the 28th, because
2025-02-29 makes Postgres throw 22008 and makes a `Date` roll forward to 1 March.
Mutating it back to the rolling window reproduces `2026-01-29` exactly.

### Still true, and still unowned

`ar.control.v1` and `ap.control.v1` remain **unowned** (C1). The direction rule
removes an account that was never a control account; it does not decide which of
the remaining candidates is canonical, and that is still a business call about
the chart of accounts. `controlAccountAmbiguous` is `true` on both Velocity
roles and both Brightsphere roles.

---


## B. Defects found that the specification never mentions

These are the ones that matter most: nobody was looking for them.

| # | Finding | Amount | Status |
|---|---|---|---|
| B1 | **Equity computed without retained-earnings-brought-forward** across nine endpoints; seven computed it inline, so fixing the shared function alone would have left seven silently wrong | **R28,356,760.75** on Velocity's balance sheet | FIXED (parallel session) |
| B2 | **`allocateTransaction` with `allocType='customer'`** posts DR Bank / CR AR and writes NO allocation rows and NO `amount_paid`. This does not explain the unapplied cash — it *produces* it, and every bulk run adds to it | R2.45m and growing | REPORTED — write path, out of scope |
| B3 | **No canonical AR/AP control account.** 13 accounts carry `subtype='receivable'`, one carries NULL. Sub-ledgers tie to control on **no** company | variances to **R41.6m** | **OPEN — needs Hein's decision** |
| B4 | **`gl_accounts.is_active` used as a filter inside balance queries** in ~10 places. It is a picker flag and says nothing about whether an account holds money | 4 accounts hold **R137,317.39** incl. R6,550 cash | REPORTED — parallel session sweeping |
| B5 | `casewareExportService` filtered `is_active = true` and dropped a dormant account, leaving the export out of balance by exactly that | R130,000 | FIXED (parallel session) |
| B6 | **A predicate in a `LEFT JOIN ... ON` clause restricts nothing.** `kpiChartsService` had `is_active AND subtype='bank'` in an ON clause; unmatched rows survived with NULL account columns and were summed. The cash trend chart included every transaction in the company | — | REPORTED |
| B7 | **A `COALESCE` at the query layer makes a validation layer above it unreachable.** `getFiscalYearStartMonth` could not refuse a NULL because the SQL had already substituted 3 | — | FIXED (parallel session) |
| B8 | **`emp201Service` swallows every error** in a `try/catch` returning a zero-filled result, so a broken query reads as **"no PAYE due"** — a silent failure on a statutory return | — | REPORTED — escalated |
| B9 | `emp201Service` status filter is `'calculated'`, matching **1 of 86** pay runs | — | FIXING (parallel session) |
| B10 | **Zero of 39,285 journal lines** carry a `project_id`, across all four live companies. `projects` has 0 rows | 100% of P&L untagged | FIXING (W6) — reported as completeness, not an empty list |
| B11 | **Paycard coverage hole in both directions.** 12 Velocity 1610xxx accounts carry GL balance with zero transactions; 1544xxx accounts carry transactions with no GL | ~R99k | FIXING (W3) |
| B12 | A **completed** bank reconciliation with a R0.00 difference and **no matched transactions** — a reconciliation that proves nothing but looks done | — | FIXING (W3) |
| B13 | `fiscal_periods.fiscal_year` is **calendar-based**: Feb 2026 is stored as 2026 but belongs to the March-2025 fiscal year | — | REPORTED |
| B14 | **Silent March fiscal-year default.** `financial_year_start || 3` in 5 ad-hoc sites plus the shared basis. A December-year-end tenant would get a year-end close a quarter out with nothing flagging it | — | FIXED in the shared basis; 5 sites REPORTED |
| B15 | **`budgetService` has never executed.** INSERTs into 12 columns that do not exist, omits 2 NOT NULL columns, `ON CONFLICT` has no matching constraint. Write path and read path disagree about the schema | 0 rows in prod | FIXING (W6) |
| B16 | Brightsphere carries **R7,500 accumulated depreciation against R0 of asset cost** — negative net book value on the face of the balance sheet. Register and GL disagree in both directions | R7,500 | FIXING (W6) |
| B17 | Velocity has **no account coded 5200 or 1110**; salaries sit on Sage-imported `49784360` / `49784353`, so payroll posting cannot resolve its accounts | — | REPORTED |
| B18 | `users.id` is `character varying(255)`, not `uuid`. A uuid-typed FK or `::UUID` cast against it fails at apply time | — | REPORTED — CI guard exists |
| B20 | **`customer-allocations.ts:130` compared `invoice.client_id !== payment.client_id`.** `customer_invoices` carries BOTH `client_id` and `customer_id`; an invoice populated on `customer_id` alone has `client_id` NULL, so the comparison was true for every such invoice and the route **refused to allocate it at all**. This is the only UI path for applying an existing receipt | plausibly the **direct cause** of R2.45m never being applied | FIXED (W1) |
| B21 | `customer-allocations.ts` wrote `amount_paid` as an **absolute** computed in JS from a value read moments earlier — a lost update; returned `badRequest` from **inside** the write loop, and `withAuth` COMMITs under 500, so a 3-line request failing on line 3 committed lines 1–2 and reported failure; and took **no row lock**, so two applications of one receipt both passed the remainder check | — | FIXED (W1) |
| B22 | **`allocateTransaction(allocType='supplier')` inserts NOTHING.** Posts DR AP / CR Bank and sets a `payment_matched` BOOLEAN; never moves `amount_paid` or `status`, and creates no payment document. This is why all 17 bills read as open against a Sage book showing every one paid | R613,642 | REPORTED — write path, out of scope |
| B23 | **`supplier-allocations.ts` writes a dead table.** `supplier_payment_allocations` — 0 rows in dev and prod, read by nothing — while `processSupplierPayment`, `voidSupplierPayment` and `batchPaymentService` all use `payment_allocations`. Its allocations were invisible downstream. It also walked a PROCESSED payment back to `'approved'`, and `voidSupplierPayment` accepts only `processed`, so it quietly became un-voidable | — | FIXED (W1) |
| B24 | **`allocateTransaction` SKIPS its payment INSERT** when it cannot resolve a uuid-shaped user, so cash reaches the AR control account by plain journal with no `customer_payments` row behind it. `list_unapplied_receipts` cannot see that state | — | REPORTED — `reconcile_subledger` (W2) must find it |
| B25 | **No supporting documentation exists anywhere.** `procurement_documents`, `document_links` and `bank_transaction_attachments` all hold **0 rows in production**. Transactions ≥ R10,000 with no document: Velocity 2,079 of 2,079, Brightsphere 1,266 of 1,266, Demo 1,290 of 1,290 — 100% on every company | — | REPORTED |
| B26 | Journals with neither `actor_type` nor a resolvable posting agent — genuinely unattributable. One is R7,500 | 8 rows | REPORTED |
| B27 | A fully applied receipt flips to `'reconciled'`, but `cancelCustomerPayment` accepts only `'confirmed'` — so a fully applied receipt can no longer be cancelled. Pre-existing, not introduced | — | OPEN — candidate for W2/W5 |
| B28 | **`bulk_allocate_bank_transactions` has produced R39,486,371.68 of the R42,759,565.12 unapplied system-wide — 92.3%.** Velocity Fibre's R37,050,347.68 is **100% agent-made** and 13.8× the Brightsphere figure the audit leads with; Velocity is absent from that section entirely. The tool ties to the cent on the GL side and leaves the subledger untouched | **R39.5m** | REPORTED — write path, out of scope |
| B29 | **An MCP agent was bulk-allocating PRODUCTION during this programme** — 364 journals at 01:00, 150 at 02:00, 300 at 03:00 UTC on 2026-09-03, still running at 04:23:54. Velocity's bank gap moved from +R2.44m to −R522k **and flipped sign** mid-measurement | — | **OPEN — see C4** |
| B30 | **397 Velocity supplier invoices flagged `payment_matched = true` while showing R16,151,543.00 outstanding.** `recordPaymentMatch` sets a boolean and never moves `amount_paid`. Brightsphere has zero flagged — the two companies have *different* AP defects | R16.15m | REPORTED |
| B31 | **`yearEndService.closeFiscalYear` has NEVER worked.** INSERTs `total_debit`/`total_credit`, neither of which exists — 42703 on every live call, over MCP and through the UI. The four unclosed year-ends were not an oversight; the operation was impossible. **Still on master after `d5ad20a8`** | — | FIXING (W3) |
| B32 | The same INSERT omitted `fiscal_period_id`, and the next statement **locks every period in the year** — so the closing journal would sit outside the trial balance, the VAT201 and the AFS, permanently and uncorrectably | — | FIXING (W3) |
| B33 | **No customer statement has ever shown a credit note.** `fetchStatementData` filtered `status = 'approved'` while a note moves to `'applied'` on being set against an invoice. **92 notes, R372,519.32**, invisible — every emailed statement overstated what the customer owed by their full value. This went to real people | R372,519.32 | FIXED (W6) |
| B34 | The statement claimed a 365-day window it never applied — `fromDate` was computed then never used as a lower bound, so it ran from inception regardless, and `toISOString()` made it a day early on this UTC+2 host | — | FIXED (W6) |
| B35 | **ETI unbalances the payroll journal.** The poster subtracts ETI from the labour DEBIT and credits it nowhere, so any run claiming ETI throws "unbalanced". Correct treatment reduces CR 2140. All 86 production runs carry `total_eti = 0.00`, so nobody has hit it | — | **OPEN — accounting treatment is a human decision** |
| B36 | **Velocity posts input tax to a NULL-subtype account** (SYS-9 "VAT Payable"): 356 posted lines, **R4,917,814.24**, dropped from the VAT201 entirely by the subtype filter with no signal | R4.92m | FIXING (W4) |
| B37 | `account_subtype = 'tax'` is not VAT. Brightsphere 34550639 "Pay As You Earn" is an **expense** account carrying it, and `getVATReturn` accepted `'tax'` as a VAT control subtype — pulling R23,219.01 of PAYE into box 15 | R23,219.01 | FIXED (W4) |
| B38 | **`budgetService` INSERTs into 12 columns that do not exist**, omits 2 NOT NULL columns, and its `ON CONFLICT` has no matching constraint. Write path and read path disagree about the schema. 0 rows in production | — | FIXING (W6) |
| B39 | **A completed bank reconciliation is trivially balanced before anything happens** — `startReconciliation` sets `reconciled_balance = gl_balance`, so an empty session reconciles at R0.00 with nothing matched. That is how the one "completed" production reconciliation got there | — | FIXING (W3) |
| B40 | **Platform-wide fiscal-period cliff.** Every company's periods end 2027-12-31 and the depreciation hook dates `CURRENT_DATE`, so all ten start writing NULL-period journals on **2028-01-01**. Separately the demo company has a **1,096-day hole (2028-01-01 → 2030-12-31)** that is reachable *today* — the only such gap in the database, and worse than an end date because nothing counts down to it. Zero NULL-period journals exist today | — | Detection FIXING (W3); prevention **OPEN — C5** |
| B41 | `afs_statement_lines.is_active` filtered in three AFS note generators — an inactive statement-line definition whose mapped accounts still hold money is dropped from the annual financial statements. Same shape as B5, different table | — | REPORTED |
| B42 | `writePracticeTime.ts:139` uses `toISOString().slice(0,10)` — the UTC calendar day. SAST is UTC+2, so any call between midnight and 02:00 local stamps YESTERDAY. Same class this repo already fixed once via `fmtDate`; the twin in `fiscalPeriods.ts` is fixed | — | **OPEN** |
| B43 | **The completeness identity now carries TWO self-reported numbers.** `buildEnvelope` accepts `excludedTotal` as well as `universeTotal`, so a service computing `excludedTotal := universeTotal - rowsTotal` passes unconditionally regardless of what it actually excluded. No documented invariant breaks — CONTRACTS §1 already says the envelope proves internal consistency and not completeness — but a call site passing `excludedTotal` must be reviewed on its own terms, because the envelope cannot catch it | — | REPORTED — caveat in CONTRACTS |
| B19 | **Cash has two legitimate and disagreeing senses** — the GL ledger sense and the bank-statement-feed sense. `cash-movement` reads the feed, `reports-bank-transactions` reads the GL | — | FIXING (W3) — registering BOTH, gap is `bank_statement_coverage`'s output |

---

## C. Open — nobody owns these

**C1. Which account is *the* AR control account, and the AP one?**
There is no canonical answer in the schema, the sub-ledgers tie on no company,
and two reasonable queries give two different answers. `ar.control.v1` and
`ap.control.v1` are deliberately left unowned in
`src/lib/mcp/contracts/figures.ts` — registering an owner would encode an
arbitrary choice as truth and destroy the only thing that can detect the break.

Recommendation: `reconcile_subledger` reports **per control account** rather than
picking one, and `chart_of_accounts_health` flags that thirteen exist. The tools
then expose the ambiguity instead of resolving it silently. Deciding which
account *should* be canonical is a business call about the chart of accounts.

**Owner: Hein.**

**C2. Migrations 530 and 531 are not applied to production.**
Actor attribution therefore reads 0 recorded / 15,497 derived across prod, and
every posting made before that deploy can only ever be inferred. Not urgent in
itself, but each day of delay is another day of postings that cannot be proven
either way.

**Owner: Hein — deploy sequencing.**

**C4. Something is writing to the production ledger, unattended.**
Verified directly: `mcp:bulk_allocate_bank_transactions:v1` posted 364 journals
at 01:00, 150 at 02:00 and 300 at 03:00 UTC on 2026-09-03, and was still going at
04:23:54. It is the same tool responsible for 92.3% of all unapplied receipts
(B28). Every Velocity acceptance figure in this programme is unstable while it
runs — W3's bank gap flipped sign mid-measurement.

**Owner: Hein — decide whether that run is intended, and stop it before anyone
signs off a figure.**

**C5. `gl_journal_entries.fiscal_period_id` should be `NOT NULL`.**
It is the only thing that makes B40 unreachable rather than merely detected.
There are **zero** NULLs across every tenant today, so this is the cheapest it
will ever be. It forces every writer to carry a period, including raw-INSERT
paths no single workstream can see, so it needs a coordinated sweep.

**Owner: the integrator, after the six branches land.**

**C6. Fill the demo company's 2028–2030 period gap?**
Creating a period changes no existing figure and affects only journals not yet
written, so it is closer to configuration than to correcting the books — but it
sits on the edge of the standing no-data-changes rule, and it is the demo company
rather than a client ledger.

**Owner: Hein.**

**C3. The integration-test gate cannot go green without a dev server.**
4 of 45 suites (`api/zod-validation`, `api/csrf`, `csp-headers`,
`2fa-enroll-flow`) fetch `http://localhost:3200`, and nothing listens there.
Every DB-backed ledger suite passes — 42 of 45 suites, 180 tests. Nobody should
start a dev server unilaterally while other worktrees build, because that is how
this repo's `.next` gets clobbered. Someone needs to own a window for it.

Related trap: **`bun run ci` silently SKIPS the integration gate** unless
`DATABASE_URL` is exported, and then reports it as failed once it is supplied.

---

## D. Deliberately not fixed

Recorded so that "we knew and chose not to" is distinguishable from "we missed
it". Each is correct to leave.

- **Every data correction on the Velocity and Brightsphere books.** Out of scope
  by decision; happens after the endpoints exist.
- **B2 `allocateTransaction`.** Write path. Fixing it stops the bucket filling;
  it does not empty it, and it is not this programme's scope.
- **The 5 ad-hoc fiscal-year derivations.** Two are payroll and two are AFS;
  converging them now would collide across workstreams. Registered in the figure
  registry's `contested` field so a sixth is not written.
- **No backfill of `actor_type`.** A derived value can be corrected when the
  derivation proves wrong; a backfilled one can never afterwards be told from a
  recorded one, which is the property that makes an audit trail worth having.
- **The payroll GL accounts on Brightsphere.** Activating an account is a
  production data change. `post_payroll_journal` refusing and naming the codes
  IS the correct output.
