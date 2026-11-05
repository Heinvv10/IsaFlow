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
3. **Default 30 → "Not set" → the company default (Hein, 2026-11-05 ruling).** Contacts still on the
   column default are migrated to not set; Hein/Willie confirm real terms for the material suppliers. A
   not-set contact is dated by the **company default terms**, a per-company setting (Company settings →
   General → "Default payment terms"; same number + type shape; every company starts at 30 days from
   invoice, so nothing moves at the migration). It applies to NEW documents everywhere: UI capture, the
   server fallbacks, recurring runs and templates, quote/order/time/WIP conversions, scanned bills, MCP and
   Sage. The contact shows "Terms not confirmed — using company default (30 days from invoice date)".
   **Re-apply (PR 3) skips not-set contacts** and flags them. New contacts must CHOOSE terms (no
   pre-selection; "Use company default" is a valid choice and stores NULL/NULL).
   Owner/admin only to change (`withRole('admin')`), and every change is recorded in the entity history (migration 961,
   entity type `company_setting`: who, when, old → new).
   Stored in `accounting_settings` (key `default_payment_terms`, JSON): `companies` is column-level
   read-only for the app pools since migration 936, so a new column there would not be writable by a tenant.
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

## Precedence for a supplier bill's due date

1. a due date the document or caller gave;
2. the bill's OWN terms when someone chose them (`net30`, `immediate`; the new-bill page sends none unless the user picked one);
3. the supplier's terms;
4. the company default. A customer invoice: given date > customer terms > company default.

## Expand / tighten (PR 1 and PR 1b)

The build that ships PR 1 runs beside the old code (the live colour during the build; a rollback is code-only), and the old
code still writes the old shapes: `createSupplier` writes `(30, NULL)`, `createCustomer` writes `'days'`, the migration importer
writes `?? 30`. So:

- **960 (PR 1, expand).** Maps the data and DROPS the column DEFAULTs (30 / 'days'), so an insert that names no terms stores
  not set: the importers (`migrationExecuteContacts`, `sageMigrationCommitService`, `scripts/import-sage-britech.ts`) also write NULL / NULL explicitly.
  Dropping the default is safe beside the old code (every old writer that means terms names both columns). It adds NO CHECK. The new code reads every legacy shape
  (`shared/paymentTerms.readTerms`: `'days'` = invoice_days, `'end_of_month'` = statement_days, a number with no type =
  invoice_days; a negative, over-999 or unknown-type row is not terms). Tested by
  `tests/integration/payment-terms-960-migration.int.test.ts` (every legacy shape, idempotent, old-code writes still succeed).
- **PR 1b (tighten): NOT in this PR; its own migration, applied only after PR 1 is live and the old colour is gone.**
  Take the next free prefix, then:

```sql
SET LOCAL lock_timeout = '5s';
-- anything the old code wrote in the window: legacy names and the over-cap rows, mapped exactly as 960 maps them
UPDATE suppliers SET payment_terms_type = CASE WHEN payment_terms_type IS NULL OR payment_terms_type = 'days' THEN 'invoice_days'
  WHEN payment_terms_type = 'end_of_month' THEN 'statement_days' ELSE payment_terms_type END
WHERE payment_terms IS NOT NULL AND payment_terms_type IN ('days', 'end_of_month') OR (payment_terms IS NOT NULL AND payment_terms_type IS NULL);
-- (same for customers); then rows that are neither both-NULL nor a valid pair become NULL / NULL
ALTER TABLE suppliers ADD CONSTRAINT suppliers_payment_terms_shape CHECK (
  (payment_terms IS NULL AND payment_terms_type IS NULL)
  OR (payment_terms BETWEEN 0 AND 999 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months'))) NOT VALID;
ALTER TABLE suppliers VALIDATE CONSTRAINT suppliers_payment_terms_shape;  -- and the same two statements for customers
```

  Accepted as transient (round 2, 2026-11-05): during the deploy window and after a code-only rollback the OLD colour reads a
  contact with a new type value (`statement_days`, `statement_months`, or NULL / NULL) as no usable terms, so a customer invoice it
  creates for that contact is undated. PR 1b waits until the old colour is gone for the same reason.

  The 999 cap in the CHECK is what makes the DB and the forms agree (the forms and `dueDateFromTerms` already refuse more).
  PR 1b ships with an integration test that the CHECK rejects bad pairs, and its own deploy check that no contact row violates it.

## Edit pages and bank details

PR 1 also ships supplier and customer edit pages (`/accounting/suppliers/[id]/edit`, `/customers/[id]/edit`; PUT on
`suppliers-list` and `customers`). **The supplier edit never changes bank details** (Hein, 2026-11-05): a PUT naming any bank
field is a 400, and the form shows the bank details read-only and masked. A rename still goes through the bank-details stamp
(the payee name is in the payment digest, migration 923).

## Build (task DAG)

| PR | Scope | Depends on |
|---|---|---|
| 1 Terms model | migration 960 (expand: default-30 → not set, legacy names mapped; no CHECK), shared pure `dueDateFromTerms` + company default, supplier + customer forms and edit pages, every document creator dated by contact terms then company default, fix `calculateDueDate` UTC bug + hardcoded 30s, Sage import paths | — |
| 1b Tighten | CHECK (N ≤ 999) on suppliers and customers; applied only after 1 is live | 1, deployed |
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
