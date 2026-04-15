# Phase 5 — Wave 2 Stream 2C: Schema/NOT-NULL Invariant Check

**Date:** 2026-04-15
**Auditor:** Automated stream 2C (claude-sonnet-4-6)
**Scope:** `src/modules/accounting/services/` — all 76 files containing INSERT statements

---

## Summary

- **INSERT sites audited:** 148 (across 76 service files)
- **Money-moving INSERT sites (P0 tables):** 36 (customer_invoices ×6, supplier_invoices ×4, bank_transactions ×4, gl_journal_entries ×6, gl_journal_lines ×11, customer_payments ×2, supplier_payments ×2, credit_notes ×1)
- **Findings:** P0: 5 · P1: 0 · P2: 0 · P3: 0
- **Previously fixed (known context):** BL-42 (credit_notes.company_id), BL-41 (sage_customer_invoices company_id/customer_id), BL-43 (gl_migration_runs.company_id)

---

## NOT-NULL columns per accounting table (reference)

Only columns that are NOT-NULL **and have no column default** are listed — these must be explicitly provided in every INSERT.

| Table | NOT-NULL / no-default columns |
|-------|------------------------------|
| `bank_transactions` | `bank_account_id`, `transaction_date`, `amount`, `company_id` |
| `customer_invoices` | `invoice_number`, `customer_id`, `created_by`, `company_id` |
| `customer_payments` | `client_id`, `payment_date`, `total_amount`, `created_by`, `company_id` |
| `supplier_invoices` | `invoice_number`, `supplier_id`, `invoice_date`, `created_by`, `company_id` |
| `supplier_payments` | `supplier_id`, `payment_date`, `total_amount`, `created_by`, `company_id` |
| `credit_notes` | `type`, `credit_date`, `created_by`, `company_id` |
| `gl_journal_entries` | `entry_date`, `created_by`, `company_id` |
| `gl_journal_lines` | `journal_entry_id`, `gl_account_id`, `company_id` |

Note: `customer_invoices.subtotal` and `total_amount` are NOT-NULL but have defaults of `0`. `customer_invoices.client_id` is nullable (COALESCE pattern); `customer_id` is NOT-NULL without default.

---

## Findings

| # | File:line | Table | Missing NOT-NULL column(s) | Severity | Evidence | Proposed fix |
|---|-----------|-------|---------------------------|----------|----------|--------------|
| 1 | `src/modules/accounting/services/bank/bankFeedSyncService.ts:149` | `bank_transactions` | `company_id` | **P0** | INSERT lists `bank_account_id, transaction_date, amount, description, reference, bank_reference, status, import_batch_id` — `company_id` absent. `company_id` IS NOT-NULL with no default; Neon will reject the row with a constraint violation, silently swallowed in the sync loop's per-transaction catch. | Add `company_id` to INSERT column list; derive from `connection.company_id` or from `bank_accounts.company_id` JOIN already used in the connection lookup. |
| 2 | `src/modules/accounting/services/bank/openBankingSyncService.ts:70` | `bank_transactions` | `company_id` | **P0** | INSERT lists `bank_account_id, transaction_date, amount, description, reference, bank_reference, status` — `company_id` absent. Same constraint violation as Finding 1; the function `importTransaction` receives `bankAccountId` but not `companyId`. | Add `companyId` parameter to `importTransaction()` and include `company_id` in the INSERT. |
| 3 | `src/modules/accounting/services/ar/quoteConvertService.ts:83` | `customer_invoices` | `invoice_number`, `customer_id`, and wrong column `total` (should be `total_amount`) | **P0** | INSERT: `(company_id, client_id, invoice_date, due_date, subtotal, tax_amount, total, notes, status, created_by)`. Three problems: (a) `invoice_number` NOT-NULL without default is absent → constraint violation; (b) `customer_id` NOT-NULL without default is absent → constraint violation; (c) column `total` does not exist in `customer_invoices` (column is `total_amount`) → immediate SQL error. All three cause the `convertToInvoice` path to always fail at the DB layer. | Generate an invoice number via `company_document_numbers` (same pattern as `salesOrderWorkflowService`), use `total_amount` not `total`, add `customer_id = ${quote.clientId}`. |
| 4 | `src/modules/accounting/services/core/recurringTransactionService.ts:165` | `customer_invoices` | `invoice_number`, `customer_id`, `created_by` | **P0** | INSERT: `(company_id, client_id, invoice_date, due_date, reference, notes, currency, lines, subtotal, vat_amount, total_amount, status)`. Three NOT-NULL columns absent: `invoice_number`, `customer_id`, and `created_by`. All three cause a DB constraint violation; the recurring invoice job silently fails to create the invoice row. | Add `invoice_number` (auto-generate), `customer_id = client_id`, `created_by = userId` (the `userId` parameter is already available in the outer function). |
| 5 | `src/modules/accounting/services/core/recurringTransactionService.ts:192` | `supplier_invoices` | `invoice_number`, `created_by` | **P0** | INSERT: `(company_id, supplier_id, invoice_date, due_date, reference, description, currency, lines, subtotal, vat_amount, total_amount, status)`. Two NOT-NULL columns absent: `invoice_number` and `created_by`. These cause a DB constraint violation; the recurring supplier invoice job silently fails. | Add `invoice_number` (auto-generate, e.g. `SINV-{timestamp}`) and `created_by = userId`. |

---

## Clean sample

Representative correct INSERTs that pass the NOT-NULL invariant check:

**1. `customerPaymentService.ts:128` — `customer_payments`**
```sql
INSERT INTO customer_payments (
  id, company_id, client_id, payment_date, total_amount, payment_method,
  bank_reference, bank_account_id, description, project_id, created_by
) VALUES (...)
-- All 5 NOT-NULL/no-default columns present: client_id, payment_date, total_amount, created_by, company_id
```

**2. `supplierPaymentService.ts:156` — `supplier_payments`**
```sql
INSERT INTO supplier_payments (
  company_id, supplier_id, payment_date, total_amount, payment_method,
  bank_account_id, reference, description, created_by
) VALUES (...)
-- All 5 NOT-NULL/no-default columns present: supplier_id, payment_date, total_amount, created_by, company_id
```

**3. `creditNoteService.ts:91` — `credit_notes`**
```sql
INSERT INTO credit_notes (
  company_id, type, client_id, customer_invoice_id, supplier_id, supplier_invoice_id,
  credit_date, reason, subtotal, tax_rate, tax_amount, total_amount,
  project_id, created_by
) VALUES (...)
-- All 4 NOT-NULL/no-default columns present: type, credit_date, created_by, company_id
```

**4. `journalEntryCrudService.ts:206` — `gl_journal_entries` + `gl_journal_lines`**
```sql
INSERT INTO gl_journal_entries (
  id, company_id, entry_date, fiscal_period_id, description, source,
  source_document_id, created_by
) VALUES (...)
INSERT INTO gl_journal_lines (
  journal_entry_id, gl_account_id, debit, credit,
  description, project_id, cost_center_id, vat_type, company_id
) VALUES (...)
-- gl_journal_entries: entry_date, created_by, company_id ✓
-- gl_journal_lines: journal_entry_id, gl_account_id, company_id ✓
```

**5. `bankImportService.ts:65` — `bank_transactions`**
```sql
INSERT INTO bank_transactions (
  company_id, bank_account_id, transaction_date, value_date, amount,
  description, reference, import_batch_id
) VALUES (...)
-- All 4 NOT-NULL/no-default columns present: bank_account_id, transaction_date, amount, company_id ✓
```

---

## BL Issue Cross-Reference

| Finding | Suggested BL ticket | Pattern |
|---------|--------------------|---------| 
| 1 — bankFeedSyncService `bank_transactions` missing `company_id` | BL-51 | Same class as BL-42 (missing company_id on money INSERT) |
| 2 — openBankingSyncService `bank_transactions` missing `company_id` | BL-52 | Same class |
| 3 — quoteConvertService `customer_invoices` missing 3 columns incl. wrong col name | BL-53 | Silent failure on quote→invoice conversion (always fails at DB) |
| 4 — recurringTransactionService `customer_invoices` missing 3 NOT-NULL cols | BL-54 | Silent failure on recurring invoice generation |
| 5 — recurringTransactionService `supplier_invoices` missing 2 NOT-NULL cols | BL-55 | Silent failure on recurring supplier invoice generation |

> **Note on BL-53:** The use of `total` (non-existent column) means this INSERT has been throwing an SQL error since deployment — any quote conversion attempt returns a 500. This is not a "silent" failure but an always-fail code path.
