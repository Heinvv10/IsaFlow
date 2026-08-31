-- 521: Deny input VAT on entertainment-class expense accounts.
--
-- VAT Act s17(2)(a) denies input tax on entertainment — food, beverages and
-- hospitality, to staff or clients alike. Every bank rule pointing at Staff
-- Welfare carried vat_code = 'standard', so the rule auto-post path split each
-- restaurant charge 15% exclusive and debited VAT Input. On Brighttech alone
-- that claimed R43,022.36 of input tax across 480 journals.
--
-- gl_accounts.default_vat_code = 'none' is now read by both posting paths as a
-- DENIAL, not merely a default: a request to claim standard VAT against such an
-- account is coerced to 'none' and logged. Every account that already carried
-- 'none' before this migration is a balance-sheet or loan account, where the
-- coercion is a no-op.
--
-- This migration only fixes FORWARD posting. Journals already posted are left
-- untouched — sweep them with the allocation VAT mismatch report
-- (/api/accounting/vat-allocation-mismatches) and correct them through
-- reverseJournalEntry, never by editing posted lines.

-- 1. Flag entertainment-class expense accounts.
UPDATE gl_accounts
SET default_vat_code = 'none', updated_at = NOW()
WHERE account_type = 'expense'
  AND COALESCE(default_vat_code, '') <> 'none'
  AND (
       account_name ILIKE '%entertain%'
    OR account_name ILIKE '%staff welfare%'
    OR account_name ILIKE '%catering%'
    OR account_name ILIKE '%refreshment%'
  );

-- 2. Stop the rules regenerating the claim. A rule whose target account denies
--    input tax must not carry a standard vat code — the posting path would
--    coerce it anyway, and leaving it set makes the rule list lie about what
--    the next sweep will do.
UPDATE bank_categorisation_rules r
SET vat_code = 'none', updated_at = NOW()
FROM gl_accounts ga
WHERE ga.id = r.gl_account_id
  AND ga.company_id = r.company_id
  AND ga.default_vat_code = 'none'
  AND COALESCE(r.vat_code, '') <> 'none';

-- 3. Same for learned categorisation patterns, whose vat_code defaulted to
--    'standard' regardless of the account they pointed at.
UPDATE categorization_patterns p
SET vat_code = 'none'
FROM gl_accounts ga
WHERE ga.id = p.gl_account_id
  AND ga.default_vat_code = 'none'
  AND COALESCE(p.vat_code, '') <> 'none';
