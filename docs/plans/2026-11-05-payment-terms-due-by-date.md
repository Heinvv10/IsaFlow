# Payment terms + "Due by date" AP/AR report

Date: 2026-11-05 · Owner: Hein · Grilled and approved in session 2026-11-05.

## Problem

Hein wants to see, per supplier/customer, what is payable/receivable by a chosen date
(e.g. Velocity: what must be paid by 30 Nov on "90 days after statement" terms).

Evidence (Velocity, 2026-11-05, read-only via MCP):
- 351 open supplier bills, ~R16m. 55 bills (~R3.0m) have **no due_date** (CFS 32 of them).
- Cable Feeder Systems (R8.5m open): 143/144 due dates are **invoice + 90 days**, not
  "3 months after statement" (16 Sep invoice → stored 15 Dec, correct 31 Dec).
- Every supplier sampled carries `payment_terms = 30` — the column default, not real terms.
- AR: 26 open invoices, all with due_date (Herotel R23.8m due 30 Nov).

Code facts:
- `calculateDueDate` (`ap/supplierInvoiceService.ts`) parses only `net\d+` from the invoice's own
  terms string, ignores supplier terms, and uses `toISOString()` (UTC day-rollback).
- Supplier form has days only; supplier capture never fills due date from the supplier.
- Customer due date is filled client-side only (`useContactDefaults` → `dueDateFromTerms`).
- Recurring invoice run hardcodes `CURRENT_DATE + 30`.
- Approved supplier bills cannot have due_date edited (draft/pending_approval only).
- Aging already buckets by due_date with as-at and flags `due_date_missing`.
- No existing page lists open invoices due on/before a date per contact.

## Decisions

1. **`due_date` stays the single source of truth.** Terms derive it at capture and via
   "Re-apply terms"; it is hand-editable on approved bills (date only, audited).
2. **Terms model** (suppliers and customers):
   | type | rule |
   |---|---|
   | `invoice_days` | invoice date + N days (N=0 → Immediate / real-time) |
   | `statement_days` | month-end of invoice month + N days |
   | `statement_months` | month-end of the Nth month after the invoice month |
   | not set (NULL) | no derived date |
   Statement = month-end of the invoice month. Legacy `end_of_month` = `statement_days`.
3. **Default 30 → "Not set".** Contacts still on the column default are migrated to not set;
   Hein/Willie confirm real terms for the material suppliers. New contacts must pick terms
   (Immediate suggested).
4. **`due_date_source`** on supplier and customer invoices: `terms | manual | document | legacy`
   (all existing rows = `legacy`).
5. **Re-apply terms**: open bills only (balance > 0); overwrites `terms` + `legacy`; lists
   `manual` + `document` separately, unticked; preview old→new before any write;
   contacts with terms not set are skipped and flagged.
6. **Report "Due by date"**: per contact — Overdue now · Due today→date · **Total by date** ·
   Due later · No due date. AP and AR tabs, net cash position line (AR − AP), drill-down to
   invoices, Excel export, MCP tool `due_by_date`. Current balances only (no historic as-at in v1).

Strongest argument against: ~4 PRs + 2 migrations versus a report-only PR. Rejected because a
report over wrong stored dates leaves aging, pay-run and forecast wrong too.

## Build (task DAG)

| PR | Scope | Depends on |
|---|---|---|
| 1 Terms model | migration (terms unit/basis columns, default-30 → NULL), shared pure `dueDateFromTerms`, supplier + customer forms, AP capture auto-fills from supplier terms, server-side fallback, fix `calculateDueDate` UTC bug + recurring hardcoded 30, check Sage import paths | — |
| 2 Due-date source + edit | migration (`due_date_source`, due-date audit table), date-only edit route for approved/partially_paid bills | — (adversarial review: loosens approved-bill lock) |
| 3 Re-apply terms | preview/confirm UI + API + MCP | 1, 2 |
| 4 Due-by-date report | service, page, nav, Excel, MCP tool | — (reads due_date only) |
| 5 Velocity data | Hein confirms terms list → re-apply preview → Hein approves write | 3, deployed |

## Validation

- Unit: term function edge cases (31 Jan + 1 month, leap Feb, N=0, NULL), mutation-checked.
- Integration: approved-bill edit changes only due_date, writes audit row, company-scoped.
- **Footing**: report Overdue + Due by date + Due later + No due date = AP/AR aging total to the cent.
- Velocity acceptance: CFS bill dated 16 Sep → 31 Dec; 30 Nov AR total includes Herotel R23.8m.
- Browser proof of the page; `bun run ci`, blind `/review` + security review per PR.

## Guardrails

- Migrations need Hein's confirmation before production apply.
- No Velocity data write without Hein approving the preview.
- Production deploys after hours only, per-deploy approval.
- Open risk: no historic due-date edit history before PR 2; Sage re-import may overwrite dates (check in PR 1).
