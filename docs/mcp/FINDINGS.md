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

> **CORRECTION (W2, same day).** That R63,133,371.78 was read from the
> **DEPLOYED** connector, which predates #306. Master's aged debtors total for
> the same date is **R75,864,129.21**; the difference of R12,730,757.43 is
> exactly the null-due-date invoices #303 stopped dropping. Both numbers are
> right about different code. **Every figure in the section below that compares
> against the aged total is therefore computed from a superseded number** — the
> FINDING stands (the control accounts do disagree, and there is no canonical
> one), but do not quote the gaps. See A-live-3 for the re-derived set.

### "What are we owed?" has three defensible answers, R35.2m apart

| | | re-derived 2026-09-03 (W2) |
|---|---|---|
| Aged debtors total | R63,133,371.78 | **R75,864,129.21** — the deployed tool was pre-#306 |
| `1120 Accounts Receivable` | R27,924,289.10 | **R27,255,367.01** — moved R668,922.09 overnight |
| `SYS-7 Trade Receivables` | R32,704,547.38 | R32,704,547.38 — unchanged |
| both control accounts combined | R60,628,836.48 | **R59,959,914.39** |

| reconciling question | gap as published | **stale — do not quote** |
|---|---|---|
| aged vs `1120` alone | R35,209,082.68 | computed from the superseded aged total |
| aged vs `SYS-7` alone | R30,428,824.40 | same |
| aged vs both combined | R2,504,535.30 | same |

Re-derived, the AR difference is **R15,904,214.82** against both control
accounts combined, and `reconcile_subledger` now decomposes it into four named
items with no residual. The three-answer problem is unchanged: there is still no
canonical control account and `controlAccountAmbiguous` is `true`.

All three are defensible, all three are different, and nothing in the schema says
which is right. This is B3 demonstrated on live production data, and it is why
`ar.control.v1` is deliberately unowned. The same holds on the payables side:
`2110` at R7,925,176.42 beside `SYS-8 Trade Payables` at R37,703,241.94.

### Three more things visible on the face of the live trial balance

- **`SYS-9 VAT Payable` is a liability carrying a DEBIT of R4,917,814.24** — B36,
  the input tax on a NULL-subtype account that drops out of the VAT201 entirely.
  It is in plain sight and no report was reading it. **It reappeared through a
  second door**: `reconcile_subledger`'s posting probe adopted it as an AP
  control account, because its subtype is NULL and 356 supplier-invoice journals
  touch it. See A-live-3, defect 3.
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

## A-reports. What the assurance endpoints found once they could see

Every figure re-derived from the production ledger by the endpoint that reports
it, not taken from the audit.

### The P&L is reporting on a chart of accounts nobody has classified

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

### `profit_and_loss` v2: Velocity's gross profit is revenue less 2.4% of its costs

The layer the spec called missing was **not missing**.
`gl/accountClassification#aggregateFigures` already separates turnover from
other income and cost of sales from operating expenses from finance cost / tax,
and already counts the accounts whose subtype is unknown; `financialFiguresService`
wraps it and AFS consumes it. `reports/incomeStatementService#getIncomeStatement`
rolls its own two-way split instead. Two P&L implementations, and the registry
recorded neither.

They agree on the **bottom line to the cent** on both production companies. The
only difference is which band a figure sits in — Brightsphere's R158,412.82 of
tax is inside operating expenses on one and below the operating line on the
other. So this is one answer presented two ways, not two answers, which is why
it is survivable as a recorded divergence. `profit_and_loss` now wraps the owned
classifier; `revenue.period.v1` and `costofsales.period.v1` keep
`getIncomeStatement` as owner (the page still consumes that shape) and carry a
`contested` entry saying the disagreement is presentational and the bottom lines
tie. Three new ids — `otherincome.period.v1`, `financecost.period.v1`,
`tax.period.v1` — are owned by the classifier.

**But the classification the whole layer rests on barely exists.** All-time, over
revenue and expense accounts:

| | unclassified revenue | unclassified expenses |
|---|---|---|
| Velocity Fibre | R84,053,370.26 of R84,053,370.26 — **100%**, 4 accounts | R115,984,525.05 of R118,869,595.15 — **97.6%**, 37 accounts |
| Brightsphere | R12,410,997.90 of R13,508,486.83 — 91.9% | R577,571.05 of R5,113,638.23 |

Velocity's classified cost of sales is R2,885,070.10, so its reported FY2026
gross profit of **R29,305,100.49 is revenue less 2.4% of its costs.** The figure
is not a bug — the code did what the chart of accounts told it — and it is not a
number anyone should act on.

**The audit read this finding's sign backwards.** Its "R562,428 of overstated
gross profit from two `default_expense` accounts" is R574,253.66 on Brightsphere
today, and those accounts are NOT counted as cost of sales under the subtype
rule — so gross profit is **higher**, not lower.

### Neither company has ever posted to an equity account

**R0.00 posted equity on both Brightsphere and Velocity Fibre.** Every rand —
R8,394,848.60 and −R34,816,224.89 — is derived profit that no year-end close has
moved out of revenue and expenses. ISAFlow Demo has posted R695,000 against
R39,198,316.26 derived.

`getBalanceSheet` injects the retained-earnings plug into equity, so `totalEquity`
equals assets less liabilities **by construction**. Shipped that way first, it
reported `equityReconciles: true` on all three companies — a tautology that reads
as clean books. The second equity figure now comes from the equity accounts
themselves.

### The complete general ledger extracts, and balances

Velocity's whole posted ledger: **21,871 lines, 111 accounts, R519,723,273.19
debit and R519,723,273.19 credit**, served exactly once across 22 pages. The
audit's complaint was that no complete general ledger could be extracted at all.

Two defects caught by its tests first: a keyset cursor losing microseconds
through a JS `Date`, paging 10,603 lines where 10,460 exist; and a
`runningBalance` omitting the opening balance — invisible over any window
starting before the first journal, and the `trial_balance` defect in another
shape.

### Aged creditors was worse than aged debtors

**262 suppliers on Velocity**, returned with no total and no `truncated` flag.
More rows than the ten-row debtors case the audit leads with, same silence.

### Three endpoints now agree, which is new

Velocity AR: `aged_debtors` R75,864,129.21 = `reconcile_subledger`'s `agedTotal`
= its `subledgerTotal`. Unapplied receipts 39 / R37,719,269.77 in both, to the
cent; Brightsphere 37 / R2,691,024.00 likewise. `unexplainedDifference` is 0.00
on every company, both roles, at every date tested.

---

| Brightsphere | R12,410,997.90 of R13,508,486.83 — 91.9%, 1 account | R577,571.05 of R5,113,638.23, 3 accounts |

Velocity's classified cost of sales is R2,885,070.10, so its FY2026 gross profit
of R29,305,100.49 is **revenue less 2.4% of what it spent**. That figure is not a
bug — the code did exactly what the chart of accounts told it — and it is not a
number any human should act on. `classificationCoverage` is therefore MANDATORY
on the tool, present at every detail level including `summary`, not suppressible,
and it names the accounts. Nothing is excluded from any total: an unclassified
expense is still an expense, and the classification is the finding.

`reliable` is `false` on both production companies.

Run over FY2026 with a `prior_year` comparative, the layer earns itself:
Brightsphere's operating profit is R3,919,212.00 against a net profit of
R3,760,799.18, the difference being tax now reported below the operating line
where `getIncomeStatement` had it inside operating costs.

### Every W2 tool, re-run live after the envelope change

Seven tools, both production companies, read-only, **no completeness fault on
any response**:

| | Brightsphere | Velocity Fibre |
|---|---|---|
| `reconcile_subledger` AR / AP residual | R0.00 / R0.00 | R0.00 / R0.00 |
| `general_ledger` balanced | **true** — R76,213,877.10 each side, 11,741 lines | **true** — R519,723,273.19 each side, 21,871 lines |
| `balance_sheet` posted equity vs residual | R0.00 vs R8,394,848.60 | R0.00 vs −R34,816,224.89 |
| `aged_debtors` total vs `reconcile_subledger` agedTotal | R14,272,647.60 = R14,272,647.60 | R75,864,129.21 = R75,864,129.21 |
| `aged_creditors` total vs agedTotal | R613,641.77 = R613,641.77 | R106,743,768.45 = R106,743,768.45 |
| `profit_and_loss` coverage reliable | false | false |

**Brightsphere's ledger balances too** — R76,213,877.10 on each side across
11,741 lines. Both production ledgers can now be extracted whole and shown to
balance, which is the thing the audit said could not be done.

The `universeTotal` fix is visible on the filtered call: Velocity's
`general_ledger` restricted to `auto_supplier_payment` returns
`rowsTotal: 2,180`, `universeTotal: 21,871`, `excludedTotal: 19,691`. Before the
fix it reported a universe of 2,180 — certifying a filtered extract as the
complete ledger.

### Two identities that read clean because they could not do otherwise

Recorded together because it is the same failure twice in one day, in the two
endpoints built to catch exactly this, and it is now a standing rule in
`CONTRACTS.md`.

**`reconcile_subledger` reported `unexplainedDifference: 0.00` on every
production company and both roles while wrongly counting `SYS-9 VAT Payable` as
an AP control account.** The account brought −R4,917,814.24 into the control
balance and a `document_not_on_control_account` item of exactly +R4,917,814.24
across the same 356 documents took it back out.

**`balance_sheet` reported `equityReconciles: true` on all three production
companies while comparing the residual against itself**, because
`getBalanceSheet` injects a computed retained-earnings plug into the equity
section.

Neither looked broken. Both looked unusually clean. **An identity that always
closes cannot detect its own defects, and the more reliably it closes the more
it invites being trusted without inspection.** Both tool descriptions now say so
in the response's own words.

### Corrections to this register

- **The R63,133,371.78 in A-live was the DEPLOYED aged debtors report**, which
  predates #306. Master's is R75,864,129.21. Every gap in the "three defensible
  answers" table was computed from the superseded number and is marked stale in
  place. The finding — no canonical control account — is unaffected.
- **The audit read the `default_expense` sign backwards.** It reported that two
  accounts typed `default_expense` overstated gross profit by R562,428 because
  cost of sales was selected by NAME. Cost of sales is now selected by SUBTYPE,
  under which those accounts are NOT cost of sales — so gross profit is
  **higher**, not lower. Brightsphere's figure today is R574,253.66. Which
  treatment is right is a chart-of-accounts question, not a code one.
- **`gl/financialFiguresService#getFinancialFigures` issues its queries under
  `Promise.all` on the single pg client the request transaction holds.** It
  prints a node-postgres DeprecationWarning (removed in pg@9) and, in this
  codebase, concurrent work on one connection also corrupts the savepoint stack.
  Pre-existing and shared with AFS; deliberately NOT changed here, because
  sequencing it belongs with the income-statement convergence PR and its owner.
  The same defect in `subledgerReconciliationService` IS fixed.
- **The income-statement page still carries the rolling-window comparative.**
  `reports/priorPeriod.ts` replaces the arithmetic and is wired into MCP, but
  `pages/accounting/reports/income-statement.tsx` is untouched: it is UI, it
  belongs with the convergence PR, and until then its comparative column
  compares March against 29 January – 28 February.

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
| B3 | **No canonical AR/AP control account — verified 2026-09-04.** Velocity Fibre has two control accounts per side, holding two disjoint populations from two eras, not duplicates of one another. `SYS-7` Trade Receivables: 74 entries, all posted in a single human session on 2026-04-25 (`posting_agent` `human:f110ef4f-e388-442e-8428-1a265b8d0a6a`), entry dates 2025-07-23 to 2026-02-22, DR R32,704,547.38, and **zero credits, ever**. `1120` Accounts Receivable: agent-posted from 2026-09-02, `mcp:finalize_invoice:v1` DR R63,133,371.78 and `mcp:bulk_allocate_bank_transactions:v1` CR R37,937,614.57 plus reversals. `SYS-8` Trade Payables: 356 entries, same human session on 2026-04-25, entry dates 2025-05-28 to 2026-04-06, CR R37,703,241.94, and **zero debits, ever** — its legs are DR expense accounts and DR `SYS-9` VAT Payable R4,917,814.24. `2110` Accounts Payable: 3,669 lines, agent-posted 2026-09-01, `mcp:approve_supplier_invoice:v1` CR R69,040,526.51 and `mcp:bulk_allocate_bank_transactions:v1` DR R61,115,350.09. All 356 `SYS-8` journals correspond to real `supplier_invoices` rows. Only 5 invoice numbers appear in both populations: VEL001, VEL002, VEL003, VEL004, INV385148. Brightsphere is different again: its controls are the Sage-imported `1101` Trade Debtors Control (R11,591,623.60) and `2001` Trade Creditors Control (−R613,641.77); its `1120` and `2110` are all but empty — so the canonical account is not the same code across companies. **Load-bearing consequence:** `SYS-7` has no credits and `SYS-8` no debits because every cash-application tool posts to `1120`/`2110`. R32.7m of receivables and R37.7m of payables sit in accounts the write path cannot reach, and no further allocation will ever move them. Consolidating them is a data remediation | variances to **R41.6m** | **OPEN — needs Hein's decision** |
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
| B16 | Brightsphere carries **R7,500 accumulated depreciation against R0 of asset cost** — negative net book value on the face of the balance sheet. Register and GL disagree in both directions. **Re-verified 2026-09-04, still open:** the GL carries DR `5700` Depreciation Expense R7,500.00 / CR `1230` Accumulated Depreciation −R7,500.00, while the asset register holds one asset (`COMP-0001` "QA Test Computer 2026-04-12", purchase price R15,000.00, status `disposed`) whose `accumulated_depreciation` is 0.00 with `last_depreciation_date` NULL | R7,500 | **OPEN** |
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
| B51 | **The `payment_matched` burst is a burst, not a rate.** 361 of the 397 flagged bills were flagged on 2–3 September, when someone ran bulk allocations; the writer has since stopped. ~R13m over two days, cause unfixed, and it recurs the next time a bulk allocation runs. **Not** accruing at R3.2m/day | R13.1m | REPORTED |
| B52 | `getFinancialFigures` issues its queries under `Promise.all` on the single pg client the transaction holds — the same node-postgres pattern removed in pg@9, and concurrent work on one connection corrupts the savepoint stack. Pre-existing, shared with AFS | — | REPORTED |

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
| B58 | **`irp5_data` under-reported its own universe by an order of magnitude.** `universeTotal` was `mapped.length + excluded.length`, where `excluded` held ONE AGGREGATE ROW standing for every non-declarable run in the tax year. On `isaflow_dev` the 2031 tax year has a single `calculated` run carrying **ten employees**, and the report claimed a universe of **1** — the DB-gated test written for this failed with `expected 10, received 1` before the fix existed. Not a semantic nit: a live under-report of what the report had to classify. `rows` are employees, so a run count would have made `rowsTotal + excludedTotal === universeTotal` true in magnitude while adding employees to runs. Now one excluded row per EMPLOYEE whose pay in the year sits only on non-declarable runs, with the gross each carries, capped at 200 with `excludedTotal`/`truncatedExcludedRows` past the cap. Employees who ALSO have a declarable run are already a certificate row and are excluded from the excluded set, or they inflate the universe from both sides | — | FIXED (W6) |
| B59 | **A customer statement credited the FACE VALUE of a credit note only part of which was applied — on a document this code emails to the customer.** Approving a note applies `MIN(total_amount, outstanding)` and stores the capped figure in `applied_amount`; the status becomes `'applied'` only when that is above zero, and an `'applied'` note cannot be applied again, so the remainder is stranded. Both `statementEmailService` and `supplierStatementService` credited `total_amount` regardless — neither query even SELECTed `applied_amount` — showing the customer more credit than they received and **understating what they owe**; the supplier mirror **overstates what we owe**. Now `applied_amount` when `'applied'`, `total_amount` when `'approved'` (where `applied_amount` is 0 by construction and the note is unallocated credit held at face value) — the rule `agingRewind` and `apAgingService` already followed. **The test could not catch it because the FIXTURE could not:** `total_amount` equalled what was applied. Both fixtures now carry a note where the two differ | — | FIXED (W6) |
| B53 | **`stockValuationService` shipped with zero direct coverage of its own SQL and arithmetic**, while its docblock treated all of it as load-bearing — the only reference in `tests/` mocked the function outright. Four defects behind that gap: `'grn'` (a goods-received note, permitted by the `movement_type` CHECK and inbound by any reading) was missing from `INBOUND_MOVEMENT_TYPES` and so SUBTRACTED received stock with nothing to flag it; `'count'` was outbound **by omission**, when a stocktake records an absolute quantity and is not a delta at all; the orphan-movement disclosure reported a COUNT and a VALUE computed by a query that cannot be scoped by `company_id`, i.e. drawn from rows that may belong to other tenants — now `EXISTS`, not `COUNT`, because disclosure does not fix provenance; and `universeTotal` counted those disclosures as members of a universe that is this company's PRODUCTS. LOW: `averageCost` now returns null on a non-positive quantity rather than a confident negative, and `total_cost` is COALESCEd per row so one NULL cannot null a whole product's value. Eleven DB-gated tests added; four mutations run, four caught | — | FIXED (W6) |
| B54 | **`stockValuationService` is the one file in the branch that gets ON-versus-WHERE right on purpose, and it reads like the defect.** The tenant predicate sits in `WHERE` because the join to `products` IS the tenant boundary (in a LEFT JOIN's `ON` it would restrict nothing); `sm.created_at <= asOf` sits in the LEFT JOIN's `ON` precisely so a product whose only movements fall after the as-of date is reported at zero instead of vanishing. Both placements are now spelled out at the query so a future reader does not "fix" either one | — | DOCUMENTED (W6) |
| B55 | **Eleven more self-defining universes, in W6's own code, found by the gate and not by three reviews.** Two shapes: six adding `rowsTotal + excluded.length`, five assigning `universeTotal` the identical expression as `rowsTotal`. Judged individually rather than blanket-omitted. Three had an independent count already sitting unused: `assets.ts` ignored the `universeTotal` its own service computes from `COUNT(*)` — and that line was wrong twice over, since `disposed` is filtered from the PAGE while `rowsTotal` is global, so the synthesized universe drifted with the offset. `budgetVarianceService` now counts `lines`, the classified candidate set. Both statements count the fetched candidate rows from the SOURCE arrays before classification. The rest omit the claim: `list_items`, `list_employees`, `list_pay_runs` and `wip_report` produce their rows rather than selecting them, and for the two payroll listings the genuine wider set was already reported outside the envelope as `company_total_*`/`filtered_out` — passing it INTO the identity would raise a fault for a narrowing the caller asked for | — | FIXED (W6) |
| B56 | **Two more aggregate rows standing for N entities, the same family as B58 and B53.** `project_profitability` put ONE `no_project_tag` entry in `excludedRows` for 18,752 untagged journal lines, against rows that are PROJECTS — so the universe counted a bucket of lines as one more project. Untagged lines were never members of the universe of projects: they are a disclosure, now reported only through `project_tag_coverage`, outside the identity. `job_cost_report` did the same with one `ungrouped` bucket standing for N time entries against rows that are GROUPS. That makes **five** instances of this shape in this workstream alone (irp5, stock valuation orphans, stocktake counts, project tags, job cost), every one found by a mutation or a grep | — | FIXED (W6) |
| B57 | **`emp201_status` filters to declarable runs and reports nothing about the ones it drops — unlike `irp5_data`, which names them, from the same status list.** Both read `EMP201_DECLARABLE_STATUSES`, so a monthly declaration and a certificate agree about which runs count; but where irp5 puts each non-declarable run's employee in its exclusions, emp201 silently omits them and claimed `universeTotal: rows.length`, asserting a completeness it does not have. The false claim is removed. The asymmetry is NOT fixed: giving a statutory tool a new exclusion set is a behaviour change, not a gate fix | — | REPORTED — open |
| B64 | **The CI gate for BL-13 (`gl_journal_lines` must scope by `company_id`) could be satisfied by an unrelated comment, in both directions.** `check-internal-apis.sh` matched `FROM/JOIN gl_journal_lines` then asked whether the literal text `company_id` appeared ANYWHERE within a ±20-line `awk` window — proximity in source text, not whether the query itself was scoped. Direction one: a genuinely unscoped query (`return await sql\`SELECT SUM(debit) FROM gl_journal_lines\`;`) passed clean when a comment above the function merely mentioned `company_id`, or when an unrelated, correctly-scoped query sat within 20 lines. Direction two: a legitimately-scoped query whose predicate sat 21+ lines from its `FROM` clause failed with nothing wrong, and the failure was non-reproducible in a merge review because seven active worktrees shift line numbers under a positional check — this was the reported symptom that led to finding the hole. Replaced with `scripts/ci/glJournalLinesScopeRule.ts`: it parses the `sql`/`tx` tagged-template literal the query sits in as its own bounded span (the same technique `userIdCastRules.ts` already used for the `::UUID` guard), strips SQL comments and string literals from that span, and requires the company_id predicate to be found inside it — so distance no longer matters at all, and a comment or a quoted string inside or outside the query can no longer substitute for a real predicate. Running the rewritten gate against the live tree surfaced one real instance it now correctly flagged: `auditTrailExportService.ts`'s per-entry line query was scoped only transitively, via a `journal_entry_id` drawn from an already company_id-filtered parent query, with no `company_id` predicate of its own on `gl_journal_lines` (which has carried the column since migration 329) — not exploitable as found, but not verifiable as scoped by reading the query in isolation either. Fixed by adding the explicit predicate; see B65. Mutation-tested per CONTRACTS.md's own evidence rule in `tests/unit/ci/glJournalLinesScopeRule.test.ts` — 10 cases, including the exact reported `leak()` example (fails), an unscoped query beside a legitimately-scoped adjacent one (fails), and a correctly-scoped query with its predicate 25+ lines from `FROM` (passes) | — | FIXED |
| B65 | **`auditTrailExportService.ts`'s per-journal-entry line query scoped `gl_journal_lines` only by `journal_entry_id`, with no `company_id` predicate of its own** — safe as written, because the `journal_entry_id` values it loops over came from a parent query already filtered on `je.company_id`, and `gl_journal_lines.journal_entry_id` FKs to a single company's `gl_journal_entries` row. Found by the B64 gate rewrite, which checks each query's own template body in isolation and cannot see that upstream scoping. Fixed by adding `AND jl.company_id = ${exportRow.companyId}::uuid` directly to the query — defense in depth on the column the table has carried since migration 329, rather than relying on the FK chain through a value computed several lines above | — | FIXED |
| B60 | **All 3,669 agent-posted journal entries on Velocity Fibre's `1120` and `2110` control accounts carry `source_document_id` NULL and `source_record_id` NULL.** 2,579 entries from `mcp:approve_supplier_invoice:v1` and 1,090 from `mcp:bulk_allocate_bank_transactions:v1`, all posted 2026-09-01 onwards. There is no route from an agent-posted journal back to the document it came from; the only link is the free-text `description` field ("Supplier invoice IN004986"). This violates the programme's own definition of done — "offers a route to the documents behind every figure it reports" — inside the write path itself. It is also actively dangerous to analysis: an integrity query joining journals to source documents on `source_document_id` returns a clean zero that means nothing, and that exact mistake was made and caught during this investigation only because the join key was checked for population afterwards | — | REPORTED — write path |

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
