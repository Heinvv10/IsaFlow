-- 909: the date SARS issued a tax directive (PAYE 4a follow-ups, G3).
--
-- e@syFile code 3231 is the directive's ISSUED date (SARS BRS PAYE Employer
-- Reconciliation V25.3.0, "Directive Information", p. 42: "The date the
-- directive was issued by SARS"). tax_directives held only effective_date, so
-- 3231 carried that. Writers: the tax-directives POST/PATCH routes
-- (taxDirectiveService). Readers: payrollLumpSumFiling / directivePaymentFiling,
-- which fall back to effective_date, with a warning naming the directive, when
-- this is NULL.
--
-- Additive only: one nullable column. Existing rows stay NULL and fall back.
--
-- Rollback:
--   ALTER TABLE tax_directives DROP COLUMN IF EXISTS issued_date;
SET LOCAL lock_timeout = '5s';

ALTER TABLE tax_directives ADD COLUMN IF NOT EXISTS issued_date DATE;
