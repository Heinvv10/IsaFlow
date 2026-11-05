-- 960: payment terms model, EXPAND step (payment-terms / due-by-date plan, PR 1,
-- docs/plans/2026-11-05-payment-terms-due-by-date.md, decisions 2 and 3 and the company-default ruling).
--
-- payment_terms (integer N) stays; payment_terms_type now says what N counts:
--   invoice_days      invoice date + N days (N = 0 is Immediate)
--   statement_days    month-end of the invoice month + N days
--   statement_months  month-end of the Nth month after the invoice month
--   NULL / NULL       "not set": the contact uses its company's default terms
--
-- This file changes NO contact row. It only drops the column DEFAULTs (30 / 'days'), so an insert that names no terms
-- (the importers, a script) stores NULL / NULL, "not set", not a confirmed-looking 30.
--
-- Why no data rewrite: the build that ships it runs beside the OLD code (the live colour during the build, and after a
-- code-only rollback), and the old code reads a contact's terms only in the shapes it wrote: master's
-- ar/paymentTerms.dueDateFromTerms gives a date for `days` and `end_of_month` and null for anything else, NULL / NULL
-- included. Rewriting (30, 'days') to NULL / NULL, or 'days' to 'invoice_days', would leave the old code dating nearly
-- every new customer invoice with no due date. The new code reads every legacy shape itself (shared/paymentTerms.readTerms:
-- 'days' = invoice_days, 'end_of_month' = statement_days, a number with no type = invoice_days), so legacy rows keep
-- working and date exactly as before. The data mapping (default-30 -> not set, the type names, the bad values) and the
-- CHECK are PR 1b's, applied only after this build is live and the old colour is gone; see the plan doc.
--
-- Dropping the defaults is safe beside the old code: no old writer relies on a default for the NUMBER (old createSupplier
-- writes payment_terms ?? 30, old createCustomer names both columns, the importers write `?? 30`). Old createSupplier
-- names ONLY payment_terms, so its type is now NULL where the default used to make it 'days'; the new code reads a number
-- with no type as invoice days, and the old code never reads a supplier's type. A writer that names neither column now
-- stores NULL / NULL, which the old code reads as no terms (its due-date fallbacks apply).
--
-- Company default terms: no schema. They are the accounting_settings row `default_payment_terms` (JSON, per company), written
-- by Company settings; no row means 30 days from invoice, which is every company's start. (companies is column-level
-- read-only for the app pools since 936, so a new column there would not be writable by a tenant.)
--
-- Safe to re-run (DROP DEFAULT of a column with none is a no-op). Waits at most 5s for a table lock, so a busy table
-- fails the deploy instead of queueing every request behind it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE suppliers ALTER COLUMN payment_terms DROP DEFAULT, ALTER COLUMN payment_terms_type DROP DEFAULT;
ALTER TABLE customers ALTER COLUMN payment_terms DROP DEFAULT, ALTER COLUMN payment_terms_type DROP DEFAULT;

COMMENT ON COLUMN suppliers.payment_terms IS
  'N for payment_terms_type (days or months). NULL with a NULL type: terms not set, the company default applies.';
COMMENT ON COLUMN suppliers.payment_terms_type IS
  'invoice_days | statement_days | statement_months; NULL = not set (migration 960). Legacy rows may still hold days / end_of_month (or a number with no type) until PR 1b maps them; shared/paymentTerms.readTerms reads those.';
COMMENT ON COLUMN customers.payment_terms IS
  'N for payment_terms_type (days or months). NULL with a NULL type: terms not set, the company default applies.';
COMMENT ON COLUMN customers.payment_terms_type IS
  'invoice_days | statement_days | statement_months; NULL = not set (migration 960). Legacy rows may still hold days / end_of_month (or a number with no type) until PR 1b maps them; shared/paymentTerms.readTerms reads those.';
