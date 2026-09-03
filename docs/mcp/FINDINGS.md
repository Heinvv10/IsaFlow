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
| A13 | "R2.72m of understated employment cost" on the payroll endpoints | **Cannot be right as stated.** 86 of the 87 pay runs and all 11 `payroll_employees` rows belong to ISAFlow Demo (the 87th is Dotbiz (Pty) Ltd). Velocity and Brightsphere have zero of each — so no payroll figure of theirs can be *understated by a pay run*, because no pay run exists. The real exposure is larger and has a different shape: see **B42** | CORRECTED (W6) |

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

## A-payroll. The statutory exposure, re-derived from the production ledger

The specification says "R2.72m salaries understated" and treats payroll as an
absent module. Both are wrong. The module is real and unused, and the exposure is
**4.7x larger** than stated.

### R12,807,325.13 of salaries posted with no payroll run behind any of it

| Company | Account | Net posted | Route |
|---|---|---|---|
| Velocity Fibre | `49784360 Salaries & Wages - EX4000` | R7,734,785.71 | 217 bank allocations |
| Velocity Fibre | `49784353 COS - Casual wages - EX2009` | R2,327,887.50 | 116 bank allocations + 143 supplier invoices |
| Brightsphere | `34024641 Salaries & Wages` | R2,744,651.92 | 211 bank allocations |
| | **total** | **R12,807,325.13** | **544 bank allocations, 143 supplier invoices** |

A further R106,843.88 sits in DRAFT on Brightsphere and is correctly excluded.
The 143 supplier invoices are to an unnamed "Casuals".

### And no statutory liability was ever raised. Zero, not "understated"

Every one of these carries **zero journal lines on both companies**:
`2140 PAYE Payable`, `2150 UIF Payable`, `2160 SDL Payable`,
`2170 Net Salaries Payable`, `2175 Other Employee Deductions Payable`. Likewise
Brightsphere's `2102 PAYE Liability` and `5200`/`6001 Salaries & Wages`, and
Velocity's `49784361 Workmans Compensation`.

Zero `payroll_run_headers` and zero `payroll_employees` on both companies. All 127
`auto_payroll` journals in the database belong to ISAFlow Demo. There are 87 pay
runs in the system, not 86 — Dotbiz has one — and every one is demo data.

So net pay was coded straight to an expense account by bank allocation, 544 times,
and no PAYE, UIF or SDL was ever computed, raised or remitted against R12.8m of
employment cost.

### R399,735.97 of input VAT claimed on salary payments

R400,388.14 DR less R652.17 CR, across 30 of the 217 Velocity salary journals.
Those journals touch only three bank accounts, the salary account and VAT Input.

**Salaries are not a VATable supply.** This is not a classification argument — it
is input tax claimed on something that cannot carry it, and it is a direct
over-claim against SARS on top of the R5.1m box-15 defect already recorded.

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
| B15 | **`budgetService` has never executed.** INSERTs into 12 columns that do not exist, omits 2 NOT NULL columns, `ON CONFLICT` has no matching constraint. Write path and read path disagree about the schema | 0 rows in prod | FIXED (W6) — see B44 |
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
| B38 | **`budgetService` INSERTs into 12 columns that do not exist**, omits 2 NOT NULL columns, and its `ON CONFLICT` has no matching constraint. Write path and read path disagree about the schema. 0 rows in production | — | FIXED (W6) — duplicate of B15, same defect |
| B39 | **A completed bank reconciliation is trivially balanced before anything happens** — `startReconciliation` sets `reconciled_balance = gl_balance`, so an empty session reconciles at R0.00 with nothing matched. That is how the one "completed" production reconciliation got there | — | FIXING (W3) |
| B40 | **Platform-wide fiscal-period cliff.** Every company's periods end 2027-12-31 and the depreciation hook dates `CURRENT_DATE`, so all ten start writing NULL-period journals on **2028-01-01**. Separately the demo company has a **1,096-day hole (2028-01-01 → 2030-12-31)** that is reachable *today* — the only such gap in the database, and worse than an end date because nothing counts down to it. Zero NULL-period journals exist today | — | Detection FIXING (W3); prevention **OPEN — C5** |
| B41 | `afs_statement_lines.is_active` filtered in three AFS note generators — an inactive statement-line definition whose mapped accounts still hold money is dropped from the annual financial statements. Same shape as B5, different table | — | REPORTED |
| B46 | `writePracticeTime.ts:139` uses `toISOString().slice(0,10)` — the UTC calendar day. SAST is UTC+2, so any call between midnight and 02:00 local stamps YESTERDAY. Same class this repo already fixed once via `fmtDate`; the twin in `fiscalPeriods.ts` is fixed | — | **OPEN** |
| B47 | **The completeness identity now carries TWO self-reported numbers.** `buildEnvelope` accepts `excludedTotal` as well as `universeTotal`, so a service computing `excludedTotal := universeTotal - rowsTotal` passes unconditionally regardless of what it actually excluded. No documented invariant breaks — CONTRACTS §1 already says the envelope proves internal consistency and not completeness — but a call site passing `excludedTotal` must be reviewed on its own terms, because the envelope cannot catch it | — | REPORTED — caveat in CONTRACTS |
| B19 | **Cash has two legitimate and disagreeing senses** — the GL ledger sense and the bank-statement-feed sense. `cash-movement` reads the feed, `reports-bank-transactions` reads the GL | — | FIXING (W3) — registering BOTH, gap is `bank_statement_coverage`'s output |
| B42 | **R12,807,325.13 has been coded straight to salary and wage accounts on Velocity and Brightsphere with no payroll run behind any of it, and not one cent of PAYE, UIF or SDL was raised against it.** Route: 544 bank allocations coding net pay direct to the expense account, plus 143 supplier invoices to unnamed "Casuals". `2140 PAYE Payable`, `2150 UIF Payable`, `2160 SDL Payable`, `2170 Net Salaries Payable` and `2175 Other Employee Deductions Payable` carry **zero journal lines on both companies** — the accounts exist and have never been touched. Velocity R10,062,673.21 (`49784360 Salaries & Wages - EX4000` R7,734,785.71 over 217 bank allocations; `49784353 COS - Casual wages - EX2009` R2,327,887.50 over 116 bank allocations + 143 supplier invoices), Brightsphere R2,744,651.92 (`34024641 Salaries & Wages`, 211 bank allocations). The only `auto_payroll` journals in the database — 127 of them — belong to ISAFlow Demo | **R12,807,325.13** | REPORTED — statutory exposure, not this programme's to fix |
| B43 | **Input VAT was claimed on payments coded to salaries.** 30 of the 217 Velocity `49784360` bank allocations split the payment DR Salaries / DR `1140 VAT Input` / CR Bank — e.g. JE-2025-04159, a R345,000 payment described "Salaries & Wages", booked R300,000 salary + R45,000 input VAT. Salaries are not a taxable supply. Those 217 journals touch only three bank accounts, the salary account and VAT Input, so there is no other expense line the VAT could belong to | **R399,735.97** | REPORTED |
| B44 | **The Budget vs Actual month window was derived by comparing `Date.getMonth()` bounds, which only holds while a fiscal year starts in January.** `for (let m = startMonth; m <= endMonth; m++)`: for a fiscal year starting in any other month the bound goes backwards, the loop runs zero times, and the report shows **R0.00 of budget against real actuals** — indistinguishable on screen from nobody having set one. **The original claim that this fired in production does not survive re-derivation — but the reason is a contradiction, not a simple error.** All 13 companies **DECLARE** `companies.financial_year_start = 3`; every one of the 504 `fiscal_periods` rows **ACTUALLY** starts a year on 01-01, with `fiscal_year` equal to that calendar year. Both are true and mutually contradictory, and that gap is the misalignment W3 surfaces through `list_fiscal_periods.alignment`. Because the report reads the periods and not the declaration, every year-to-date window started in January and the loop always ran. One company (Dotbiz) has **zero** fiscal periods, and is the only caller that can reach the hardcoded March–February fallback — where the declaration is the sole signal, so March correctly stands there. The defect was real but latent on two counts, not one — the January-only convention, and the write path (B15/B38) having never produced a budget row to read. Fixed regardless: `budgetPeriodWindow` uses month ordinals, which hold for either convention. The same rewrite also added the `gl_accounts.company_id` predicate the old budget join was missing — a cross-tenant join, latent only because the table was empty | — | FIXED (W6) |
| B45 | **The live trial balance shows one fiscal year, and the salary exposure is mostly in the previous one.** Velocity's current-FY (Mar 2026 →) figures reproduce exactly — `49784353` R1,833,517.50 and `49775627 Unallocated Expense` R5,742,472.04 — but `49784360 Salaries & Wages` last moved on **2026-02-25** and its R7,734,785.71 is entirely FY2026, so it is absent from the current-year view. A reader working from the live TB alone sees R1.8m of wages, not R10.1m | — | REPORTED |
| B48 | **Budget vs Actual returns an all-zero report for Velocity Fibre, and the reason is not budgets.** The route picks its window from `(SELECT fiscal_year ... WHERE status='open' ORDER BY start_date DESC LIMIT 1)`. Velocity has all 12 periods of FY2027 open as well as FY2026, so the latest start_date wins and the "current" fiscal year resolves to **2027**. The year-to-date window is therefore `2027-01-01 → 2026-09-03` — `startDate` after `endDate`. An inverted window makes `budgetMonthKeysInWindow` return `[]` and the actuals predicate match no rows, so the report renders zero budget against zero actuals with no error. Brightsphere is unaffected (FY2027 has no open periods there). This is the fiscal-year *selection*, not the month window — one of the five ad-hoc derivations W3's registry entry owns | — | REPORTED — not fixed, W3 owns the derivation |
| B49 | **`period=current` opened the window a day early.** `new Date(y, m, 1).toISOString().split('T')[0]` renders local midnight as UTC; in SAST (UTC+2) that is 22:00 on the **last day of the previous month**, so "this month" swept in a day of the previous month's actuals. The same slice on `now` moved the end date back a day on any run between local midnight and 02:00. Same class as the `toISODate` rollback this repo already fixed once. Now `currentMonthWindow`, read off the local calendar and covered by four tests that go red against the old expression | — | FIXED (W6) |
| B50 | **`isaflow_dev` cannot be brought to schema parity with production, so DB-gated tests run against a schema 16 migrations behind.** Production has 520–581 applied; dev had only 520, 521 and 523. `bun run db:migrate` aborts on the first pending file: migration `524_redate_remaining_batch_dated_journals.sql` raises `P0001 no fiscal period covers the corrected date for: JE-2022-00004` — a production data migration whose fixture rows do not exist on dev. Nothing after 524 can be applied by the runner. Migration 590 was therefore applied to dev out of band, in a transaction, with the runner's own checksum recorded (`cb2bcd39…`). The index had also been created manually by an earlier agent with **no `schema_migrations` row at all**; it was dropped and re-created by the migration so the tracking is real | — | REPORTED — dev/prod schema drift, owner Hein |
| B51 | **`irp5_data` under-reported its own universe by an order of magnitude.** `universeTotal` was `mapped.length + excluded.length`, where `excluded` held ONE AGGREGATE ROW standing for every non-declarable run in the tax year. On `isaflow_dev` the 2031 tax year has a single `calculated` run carrying **ten employees**, and the report claimed a universe of **1** — the DB-gated test written for this failed with `expected 10, received 1` before the fix existed. Not a semantic nit: a live under-report of what the report had to classify. `rows` are employees, so a run count would have made `rowsTotal + excludedTotal === universeTotal` true in magnitude while adding employees to runs. Now one excluded row per EMPLOYEE whose pay in the year sits only on non-declarable runs, with the gross each carries, capped at 200 with `excludedTotal`/`truncatedExcludedRows` past the cap. Employees who ALSO have a declarable run are already a certificate row and are excluded from the excluded set, or they inflate the universe from both sides | — | FIXED (W6) |
| B52 | **A customer statement credited the FACE VALUE of a credit note only part of which was applied — on a document this code emails to the customer.** Approving a note applies `MIN(total_amount, outstanding)` and stores the capped figure in `applied_amount`; the status becomes `'applied'` only when that is above zero, and an `'applied'` note cannot be applied again, so the remainder is stranded. Both `statementEmailService` and `supplierStatementService` credited `total_amount` regardless — neither query even SELECTed `applied_amount` — showing the customer more credit than they received and **understating what they owe**; the supplier mirror **overstates what we owe**. Now `applied_amount` when `'applied'`, `total_amount` when `'approved'` (where `applied_amount` is 0 by construction and the note is unallocated credit held at face value) — the rule `agingRewind` and `apAgingService` already followed. **The test could not catch it because the FIXTURE could not:** `total_amount` equalled what was applied. Both fixtures now carry a note where the two differ | — | FIXED (W6) |
| B53 | **`stockValuationService` shipped with zero direct coverage of its own SQL and arithmetic**, while its docblock treated all of it as load-bearing — the only reference in `tests/` mocked the function outright. Four defects behind that gap: `'grn'` (a goods-received note, permitted by the `movement_type` CHECK and inbound by any reading) was missing from `INBOUND_MOVEMENT_TYPES` and so SUBTRACTED received stock with nothing to flag it; `'count'` was outbound **by omission**, when a stocktake records an absolute quantity and is not a delta at all; the orphan-movement disclosure reported a COUNT and a VALUE computed by a query that cannot be scoped by `company_id`, i.e. drawn from rows that may belong to other tenants — now `EXISTS`, not `COUNT`, because disclosure does not fix provenance; and `universeTotal` counted those disclosures as members of a universe that is this company's PRODUCTS. LOW: `averageCost` now returns null on a non-positive quantity rather than a confident negative, and `total_cost` is COALESCEd per row so one NULL cannot null a whole product's value. Eleven DB-gated tests added; four mutations run, four caught | — | FIXED (W6) |
| B54 | **`stockValuationService` is the one file in the branch that gets ON-versus-WHERE right on purpose, and it reads like the defect.** The tenant predicate sits in `WHERE` because the join to `products` IS the tenant boundary (in a LEFT JOIN's `ON` it would restrict nothing); `sm.created_at <= asOf` sits in the LEFT JOIN's `ON` precisely so a product whose only movements fall after the as-of date is reported at zero instead of vanishing. Both placements are now spelled out at the query so a future reader does not "fix" either one | — | DOCUMENTED (W6) |

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
