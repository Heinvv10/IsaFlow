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
   column default become not set in PR 1b (not in 960: see Expand / tighten); until then a legacy (30, 'days') contact reads as
   30 days from invoice, which dates the same. Hein/Willie confirm real terms for the material suppliers. A
   not-set contact is dated by the **company default terms**, a per-company setting (Company settings →
   General → "Default payment terms"; same number + type shape; every company starts at 30 days from
   invoice, so nothing moves when 1b runs). It applies to NEW documents everywhere: UI capture, the
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
code both writes and READS the old shapes. It writes: `createSupplier` `(30, NULL)` (it names only `payment_terms`),
`createCustomer` `'days'`, the importers `?? 30`. It reads: master's `ar/paymentTerms.dueDateFromTerms` gives a due date only
for `days` and `end_of_month`, and null for anything else, `NULL / NULL` and `invoice_days` included. So:

- **960 (PR 1, expand): drops the column DEFAULTs (30 / 'days') and nothing else. It changes NO contact row.** A rewrite of
  (30, 'days') to NULL / NULL, or of 'days' to 'invoice_days', would leave the old code dating nearly every new customer invoice
  with no due date, silently, while the old colour serves and after a code-only rollback. The new code reads every legacy
  shape through `shared/paymentTerms.readTerms` (`'days'` = invoice_days, `'end_of_month'` = statement_days, a number with no type =
  invoice_days; a negative, over-999 or unknown-type row is not terms), so legacy rows keep working and date exactly as before
  (the company default also starts at 30 days from invoice); only the "Terms not confirmed" wording arrives one deploy later.
  An insert that names no terms now stores NULL / NULL: the importers (`migrationExecuteContacts`, `sageMigrationCommitService`,
  `scripts/import-sage-britech.ts`) write NULL / NULL explicitly. Dropping the defaults is safe beside the old code: no old writer
  relies on a default for the number. Tested by `tests/integration/payment-terms-960-migration.int.test.ts` (no row changes; the
  old code's date for every legacy shape is unchanged; old-code writes still succeed; the defaults are gone).
  The old version of 960 held the data mapping below, with a test of every legacy shape: `git show 045a41116:scripts/migrations/sql/960_payment_terms_model.sql`
  and `git show 045a41116:tests/integration/payment-terms-960-migration.int.test.ts`.
- **PR 1b (tighten): NOT in this PR; its own migration, applied only after PR 1 is live and the old colour is gone** (no
  old-colour reader is left to be given a shape it cannot read). Take the next free prefix. It holds: default-30 -> not set in all
  companies (Hein's ruling (a)), the type mapping, the bad values, the CHECK, and the VALIDATE of 961's `entity_changes`
  constraint (961 leaves it NOT VALID; run in its own file, VALIDATE takes SHARE UPDATE EXCLUSIVE and lets writes through).
  The data statements, exactly as 960 had them:

```sql
SET LOCAL lock_timeout = '5s';

-- 1. Still on the default: not set.
UPDATE suppliers SET payment_terms = NULL, payment_terms_type = NULL
WHERE payment_terms = 30 AND COALESCE(payment_terms_type, 'days') = 'days';

UPDATE customers SET payment_terms = NULL, payment_terms_type = NULL
WHERE payment_terms = 30 AND COALESCE(payment_terms_type, 'days') = 'days';

-- 2 and 3. Every other row not yet in the new shape. The right-hand sides read the OLD row, so both CASEs
-- see the same legacy type.
UPDATE suppliers SET
  payment_terms_type = CASE
    WHEN payment_terms IS NULL OR payment_terms < 0 OR payment_terms > 999 THEN NULL
    WHEN payment_terms_type IS NULL OR payment_terms_type = 'days' THEN 'invoice_days'
    WHEN payment_terms_type = 'end_of_month' THEN 'statement_days'
    WHEN payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months') THEN payment_terms_type
    ELSE NULL END,
  payment_terms = CASE
    WHEN payment_terms BETWEEN 0 AND 999 AND (payment_terms_type IS NULL OR payment_terms_type IN
      ('days', 'end_of_month', 'invoice_days', 'statement_days', 'statement_months')) THEN payment_terms
    ELSE NULL END
WHERE ((payment_terms IS NULL AND payment_terms_type IS NULL)
    OR (payment_terms BETWEEN 0 AND 999 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months')))
  IS NOT TRUE;

UPDATE customers SET
  payment_terms_type = CASE
    WHEN payment_terms IS NULL OR payment_terms < 0 OR payment_terms > 999 THEN NULL
    WHEN payment_terms_type IS NULL OR payment_terms_type = 'days' THEN 'invoice_days'
    WHEN payment_terms_type = 'end_of_month' THEN 'statement_days'
    WHEN payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months') THEN payment_terms_type
    ELSE NULL END,
  payment_terms = CASE
    WHEN payment_terms BETWEEN 0 AND 999 AND (payment_terms_type IS NULL OR payment_terms_type IN
      ('days', 'end_of_month', 'invoice_days', 'statement_days', 'statement_months')) THEN payment_terms
    ELSE NULL END
WHERE ((payment_terms IS NULL AND payment_terms_type IS NULL)
    OR (payment_terms BETWEEN 0 AND 999 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months')))
  IS NOT TRUE;

-- the CHECK, once nothing violates it (N <= 999 is what makes the DB and the forms agree):
ALTER TABLE suppliers ADD CONSTRAINT suppliers_payment_terms_shape CHECK (
  (payment_terms IS NULL AND payment_terms_type IS NULL)
  OR (payment_terms BETWEEN 0 AND 999 AND payment_terms_type IN ('invoice_days', 'statement_days', 'statement_months'))) NOT VALID;
ALTER TABLE suppliers VALIDATE CONSTRAINT suppliers_payment_terms_shape;  -- and the same two statements for customers
-- in its own file, after 961: ALTER TABLE entity_changes VALIDATE CONSTRAINT entity_changes_entity_type_check;
```

  Notes for 1b:
  - Step 1 also maps the `(30, NULL)` rows the old `createSupplier` and the old `importCustomers` (`payment_terms ?? 30`, no type;
    its default type is gone after 960) write in the window: they are stamped defaults, not choices, so they become not set. New code
    never writes `(N, NULL)`; any other `(N, NULL)` row has no known writer and step 2 maps it to invoice_days N.
  - Old `createCustomer` writes `(30, 'days')` for a default and for a real "30 days" choice alike, so they cannot be told apart:
    step 1 sets them all to not set (ruling (a)). A contact with a real 30 then follows the company default, which may by then not be
    30 days from invoice: decide in 1b whether step 1 skips a company whose default has been changed.
  - **1b's UPDATEs deliberately fire the `entity_change_capture` trigger** (migration 888; ENABLE ALWAYS on `suppliers` and
    `customers`, AFTER UPDATE FOR EACH ROW). Its projection keeps every column but id, created_at, updated_at (and a supplier's
    `bank_details_setters`), so `payment_terms` and `payment_terms_type` are recorded before and after in `entity_changes`, as channel
    `system`. There is no other stored copy of the old values, so those rows ARE the undo path: do not disable the trigger for 1b, and
    keep the `entity_changes` rows. Verified by `payment-terms-960-migration.int.test.ts` ("a contact UPDATE of the terms is recorded").
  - Remaining transient after 960: a contact saved by the NEW code with a new type (`statement_days`, `statement_months`,
    `invoice_days`, or NULL / NULL) is read as no terms by the old colour after a code-only rollback, so a customer invoice the old code
    creates for that contact is undated. Nothing else: legacy rows are untouched until 1b.
  - PR 1b ships with an integration test that the CHECK rejects bad pairs and that the mapping is idempotent, and its own deploy check
    that no contact row violates the CHECK.

## Edit pages and bank details

PR 1 also ships supplier and customer edit pages (`/accounting/suppliers/[id]/edit`, `/customers/[id]/edit`; PUT on
`suppliers-list` and `customers`). **The supplier edit never changes bank details** (Hein, 2026-11-05): a PUT naming any bank
field is a 400, and the form shows the bank details read-only and masked. A rename still goes through the bank-details stamp
(the payee name is in the payment digest, migration 923).

## Build (task DAG)

| PR | Scope | Depends on |
|---|---|---|
| 1 Terms model | migration 960 (expand: drops the column defaults, changes no contact row), shared pure `dueDateFromTerms` + company default, supplier + customer forms and edit pages, every document creator dated by contact terms then company default, fix `calculateDueDate` UTC bug + hardcoded 30s, Sage import paths | — |
| 1b Tighten | the data mapping (default-30 → not set, legacy names), CHECK (N ≤ 999) on suppliers and customers, VALIDATE of the `entity_changes` constraint; applied only after 1 is live and the old colour is gone | 1, deployed |
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
