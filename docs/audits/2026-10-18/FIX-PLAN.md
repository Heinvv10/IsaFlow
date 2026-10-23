# Fix plan — audit 2026-10-18, wave 1 (CRITICAL + payroll)

Draft. Not executed. Each PR: branch from origin/master in its own worktree, TDD (test red on master first), `bun run ci` green, blind `/review` (+ adversarial ledger reviewer for GL writes), merge via `mq-isa add`, deploy after hours with Hein's approval.

## Step 0 — prod facts that set the urgency (Hein runs, or authorises a read-only census)

```sql
-- G-01: has any company posted a year-end closing journal?
SELECT c.name, je.entry_number, je.entry_date, je.reversed_at
FROM gl_journal_entries je JOIN companies c ON c.id = je.company_id
WHERE je.source = 'year_end' AND je.status = 'posted' ORDER BY je.entry_date;

-- Payroll: who runs payroll, and has any 2026/27 run (Mar 2026+) been calculated/posted?
SELECT c.name, pr.period_year, pr.period_month, pr.status
FROM payroll_run_headers pr JOIN companies c ON c.id = pr.company_id
WHERE (pr.period_year, pr.period_month) >= (2026, 3) ORDER BY 1, 2, 3;
```

If neither returns rows, G-01 and P1 are latent, not live, and wave 1 has no data repair.

**Result (prod, read-only census 2026-10-18, Hein-authorised):** no posted `year_end` journals in any company, so G-01 is latent and needs no data repair. Payroll runs exist only for ISAFlow Demo (86) and Dotbiz (Pty) Ltd (2 drafts: 2026-04, 2026-10). No real client has an approved 2026/27 run on the wrong tables. Fix before Dotbiz approves a run.

**Decision (Hein, 2026-10-18):** G-01 option A.

## PR 1 — G-01: P&L readers include the posted year-end closing journal (CRITICAL)

**Root cause.** The reporting layer is built on "the ledger holds no closing journals; closes are derived" (`reports/trialBalanceBasis.ts:12`, `gl/fiscalYearCloseRows.ts`, `balanceSheetService.calculateRetainedEarnings`). Mig 627 then let `yearEndJournalPoster` post a real `source='year_end'` journal. Every reader now sees the close twice: once derived, once posted. The P&L for a closed year nets to zero; SOCE books profit as dividends.

**Fix (recommended, option A):** reports ignore `source='year_end'` journals entirely (both legs). The derived close already does the job, so BS/TB/RE stay correct and P&L gets its numbers back. The posted journal stays as the lock/audit record.
- One shared SQL predicate, e.g. `excludeClosingJournals` fragment in `reports/` (or a view `gl_reporting_lines`), used by every reader.
- Census first: 44 files join journal lines and filter revenue/expense. Table each file: reader? includes year_end today? fixed? (memory: census by table, not by grep count). Include exports (Caseware, export_gl_lines, GL import/export, MCP `general_ledger`, `trial_balance`, `profit_and_loss`, board pack, trends, dimension P&L, AFS).
- Raw-ledger views (account ledger, journal list, GL export) keep showing the journal, flagged, since a user must be able to see it.
- Fix stale comments asserting the close "cannot run".
- **Strongest argument against A:** anything that reads the RE account's posted balance directly (not via the derived figure) would lose the close. The census must list those readers explicitly.
- **Option B:** stop posting closing journals (revert the mig 627 path) and keep the derived model only. Simpler code, but reverses a shipped decision and needs a plan for journals already posted.

**Tests (red on master first):** fixture company with one closed FY: P&L for the closed year = pre-close profit; BS A = L + E before and after close; SOCE profit line = P, dividends = 0; TB balances; CC/BU-filtered P&Ls sum to the unfiltered total; prior-year column of the following year's AFS. Mutation check: drop the predicate from one reader → its test goes red.

**Also in PR 1 (same files, same root):** G-06 (a reversed `YE-` journal still reads as closed — check `reversed_at`).

**Review:** blind `/review` + adversarial ledger reviewer (GL reporting, every tenant).

## PR 2 — payroll statutory correctness (HIGH, small and verifiable)

| Item | Fix | Verify |
|---|---|---|
| P1 | Add official 2026/27 table (brackets, rebates, thresholds, medical credits) from SARS; make `getTaxYearConfig` **throw** for an unregistered year instead of silently using the latest. | Fixtures from SARS's own monthly tables at 3+ income points per age band; test that 2028 throws. |
| P2 | ETI age 18–29; fix `.claude.md`. | Age 29 eligible, 30 ineligible. |
| P9 (K-080) | ETI below R2 000 = 75% (yr 1) / 37.5% (yr 2). | Band-edge tests at R1 999, R2 000, R4 500, R6 500, R7 500. |
| P8 | e@syFile codes: 4141 = total UIF, 4142 = SDL, 4149 totals, 3696–3699 gross totals; remove 4150 misuse. Same mapping in `irp5Service.ts`. | Golden-file test of an export against SARS BRS layout; validate in e@syFile if Hein has it. |
| P13 | Leave pay-out code 3810 → 3605/3601. | Unit test. |
| P15 | EMP201 must not turn a DB error into a nil declaration — re-throw. | Test with a failing query → 500, not zeros. |
| P10 | Age rebate by age at 28 Feb of the tax year. | Employee turning 65 in Jan gets the secondary rebate from March. |

Source of truth for every figure: sars.gov.za published tables/BRS, cited in the code comment with URL + version. No figure from memory.

## PR 3 — terminations (P4)

`updatePayrollEmployee` must not hide a leaver from the run that pays them. Include employees whose `end_date` falls in the run period regardless of status; final pay, leave pay-out, notice pay. Tests: end date before, on and after run date.

## PR 4 — PAYE method (P3, P5, P6, P7) — larger, needs grill-me first

Annual-payment method for bonuses/leave/notice pay; severance via directive (no automatic withholding at ×12); `employer_contribution` → taxable fringe + journal liability + IRP5 codes; 27.5% / R350k retirement cap incl. employer contributions; non-cash fringe-benefit component type (not paid out). This is a calculator redesign: module shape and fixtures need agreeing before code. Golden fixtures: SARS worked examples.

## Order / DAG

Step 0 → PR 1 and PR 2 in parallel (disjoint files) → PR 3 → PR 4 (after grill-me). PR 2 ships before the next pay run if Step 0 shows live payroll users.

## Wave 2 (next, not planned here)

Netcash double-submit + EFT header; AR amount_paid races (lock + DB CHECK `amount_paid <= total_amount` NOT VALID → validate); bank reversal subledger (B-01, B-21) and bulk-import dedup (B-02); VAT201 box numbering + supplier CN VAT; S-01..S-03 role fences; recurring-invoice month-end; dashboard cash.
