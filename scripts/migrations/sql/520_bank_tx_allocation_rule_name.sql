-- 520: separate the rule that fired from the account the money hit.
--
-- `allocated_entity_name` carried two different kinds of value depending on how
-- a row was allocated: the direct-allocation path stored "<code> <name>" of the
-- GL account, while the rule auto-post path stored the RULE's name ("ROMANS
-- PIZZA"). The Bank Transactions "Account" column renders that column verbatim,
-- so for rule-allocated rows — the majority of this ledger — it showed a string
-- that is not an account at all, and a bookkeeper could not see that two
-- restaurant purchases had been posted to Staff Welfare.
--
-- The rule name is worth keeping (auditing what the rules did), so it moves to
-- its own columns instead of being dropped.

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocation_rule_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocation_rule_name TEXT;

CREATE INDEX IF NOT EXISTS idx_bank_tx_allocation_rule
  ON bank_transactions(allocation_rule_id)
  WHERE allocation_rule_id IS NOT NULL;

-- Backfill: an account-allocated row whose allocated_entity_name is exactly the
-- name of one of this company's categorisation rules was posted by that rule.
-- A directly-allocated row stores "<code> <name>", which never equals a rule
-- name, so this cannot mis-claim one. Ambiguous names (two rules, same name)
-- are left alone rather than guessed.
UPDATE bank_transactions bt
SET allocation_rule_id   = r.id,
    allocation_rule_name = r.rule_name
FROM (
  SELECT DISTINCT ON (company_id, rule_name) id, company_id, rule_name
  FROM bank_categorisation_rules
  ORDER BY company_id, rule_name, created_at ASC
) r
WHERE bt.company_id = r.company_id
  AND bt.allocation_type = 'account'
  AND bt.matched_journal_line_id IS NOT NULL
  AND bt.allocated_entity_name = r.rule_name
  AND bt.allocation_rule_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM bank_categorisation_rules d
    WHERE d.company_id = r.company_id AND d.rule_name = r.rule_name AND d.id <> r.id
  );
