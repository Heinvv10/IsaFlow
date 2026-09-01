-- 521: Mark entertainment-class accounts as denying input tax (VAT Act s17(2)(a)).
--
-- Numbered 521, not 520: a concurrent branch holds 520 (bank_tx_allocation_rule_name)
-- as an uncommitted file. A gap in the sequence is harmless; a duplicate prefix
-- is not, and the migration runner keys on filename.
--
-- WHY A DEDICATED COLUMN, NOT default_vat_code
-- --------------------------------------------
-- The first cut of this reused `default_vat_code = 'none'` as the denial marker.
-- That conflates two different facts. `5800 Insurance Expense` carries
-- default_vat_code = 'none' in production and is standard-rated and CLAIMABLE —
-- reusing the column blocked a legitimate claim there. "Do not default to
-- claiming" and "you may not claim" are separate statements about an account and
-- need separate storage.
--
-- WHAT THE FLAG DOES
-- ------------------
-- It ADVISES; it does not enforce. On the Bank Transactions screen and the bank
-- rule form a user who picks Standard 15% against a flagged account sees why it
-- is usually denied and may still proceed — s17(2)(a)(i) lets a vendor who
-- continuously supplies entertainment for a charge claim that input tax, and
-- only the user knows whether that is them.
--
-- The ONE place it changes what posts is the rule auto-post sweep, where nobody
-- is watching: it posts the gross amount and reports the coercion rather than
-- inventing a claim on a schedule. That is where R43,008.01 across 478 journals
-- came from.
--
-- The flag is editable per account from the Chart of Accounts screen, so a
-- tenant wrongly flagged by the back-fill below clears it in one click.
--
-- Posted journals are NOT touched. Sweep those with
-- GET /api/accounting/vat-allocation-mismatches and correct them through
-- reverseJournalEntry — never by editing posted lines.

ALTER TABLE gl_accounts
  ADD COLUMN IF NOT EXISTS vat_input_denied BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN gl_accounts.vat_input_denied IS
  'VAT Act s17(2)(a): input tax on entertainment is denied. Advisory on the '
  'interactive paths; the rule auto-post sweep posts gross instead of claiming. '
  'Distinct from default_vat_code, which is only a default.';

-- 1. Back-fill entertainment-class expense accounts.
--
-- s17(2)(a)(i) lets a vendor who CONTINUOUSLY SUPPLIES entertainment for a
-- charge — a restaurant, caterer, hotel, conference venue — claim the input tax
-- on it. Cost-of-sales and any account whose name reads as a trading line are
-- excluded: that is where such a vendor books what it resells. Review per tenant;
-- this is a sensible default for an ordinary business, not a determination of
-- any tenant's VAT status, and the screen lets them clear it.
UPDATE gl_accounts
SET vat_input_denied = true, updated_at = NOW()
WHERE account_type = 'expense'
  AND vat_input_denied = false
  AND COALESCE(account_subtype, '') NOT IN ('cost_of_sales', 'cost_of_goods_sold')
  AND (
       account_name ILIKE '%entertain%'
    OR account_name ILIKE '%staff welfare%'
    OR account_name ILIKE '%catering%'
    OR account_name ILIKE '%refreshment%'
  )
  AND account_name NOT ILIKE '%cost of sale%'
  AND account_name NOT ILIKE '%cost of good%'
  AND account_name NOT ILIKE '%sales%'
  AND account_name NOT ILIKE '%revenue%'
  AND account_name NOT ILIKE '%income%';

-- 2. Stop defaulting a claim on those accounts. This is the DEFAULT changing,
--    not a denial: a user may still pick Standard on the screen.
UPDATE gl_accounts
SET default_vat_code = 'none', updated_at = NOW()
WHERE vat_input_denied = true
  AND COALESCE(default_vat_code, '') <> 'none';

-- 3. Clear the rules that were set to claim against a flagged account. Every one
--    of the 37 on Staff Welfare carried vat_code='standard' by accident, and the
--    sweep honoured them on every future charge. A user who genuinely supplies
--    entertainment can set the rule back.
UPDATE bank_categorisation_rules r
SET vat_code = 'none', updated_at = NOW()
FROM gl_accounts ga
WHERE ga.id = r.gl_account_id
  AND ga.company_id = r.company_id
  AND ga.vat_input_denied = true
  AND COALESCE(r.vat_code, '') <> 'none';

-- 4. Same for learned categorisation patterns, whose vat_code defaulted to
--    'standard' regardless of the account they pointed at.
UPDATE categorization_patterns p
SET vat_code = 'none'
FROM gl_accounts ga
WHERE ga.id = p.gl_account_id
  AND ga.company_id = p.company_id
  AND ga.vat_input_denied = true
  AND COALESCE(p.vat_code, '') <> 'none';
