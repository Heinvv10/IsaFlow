-- 521: Deny input VAT on entertainment-class expense accounts.
--
-- Numbered 521, not 520: a concurrent branch holds 520 (bank_tx_allocation_rule_name)
-- as an uncommitted file. A gap in the sequence is harmless; a duplicate prefix
-- is not, and the migration runner keys on filename.
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
--
-- s17(2)(a)(i) carries a proviso: a vendor who CONTINUOUSLY SUPPLIES
-- entertainment for a charge — a restaurant, caterer, hotel, conference venue —
-- may claim the input tax on it. A blanket name sweep would flag such a
-- tenant's "Catering Supplies" or "Refreshments" cost-of-sales account and
-- silently stop them claiming input tax they are entitled to.
--
-- Two guards, and neither is sufficient on its own:
--   * cost-of-sales and any account whose name reads as a trading line is
--     excluded — that is where an entertainment vendor books what it resells;
--   * the flag is a per-account column a tenant can clear from the Chart of
--     Accounts screen, so a vendor who is wrongly flagged has a one-click fix.
--
-- Review the result per tenant before relying on it. This is a sensible default
-- for an ordinary business, not a determination of any tenant's VAT status.
UPDATE gl_accounts
SET default_vat_code = 'none', updated_at = NOW()
WHERE account_type = 'expense'
  AND COALESCE(default_vat_code, '') <> 'none'
  AND COALESCE(account_subtype, '') NOT IN ('cost_of_sales', 'cost_of_goods_sold')
  AND (
       account_name ILIKE '%entertain%'
    OR account_name ILIKE '%staff welfare%'
    OR account_name ILIKE '%catering%'
    OR account_name ILIKE '%refreshment%'
  )
  -- A trading line, not a consumption line: an entertainment vendor's own
  -- supply. Never flag these.
  AND account_name NOT ILIKE '%cost of sale%'
  AND account_name NOT ILIKE '%cost of good%'
  AND account_name NOT ILIKE '%sales%'
  AND account_name NOT ILIKE '%revenue%'
  AND account_name NOT ILIKE '%income%';

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
  -- Tenant predicate, same as step 2. ga.id is a primary key so the blast
  -- radius is nil, but a cross-tenant join shape is exactly what the project
  -- rule forbids and what the next reader would copy.
  AND ga.company_id = p.company_id
  AND ga.default_vat_code = 'none'
  AND COALESCE(p.vat_code, '') <> 'none';
