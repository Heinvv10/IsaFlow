-- 676: a bank rule says what happens to the cash it books.
--
-- A rule with auto_create_entry posts DR Accounts Payable / CR Bank and creates
-- the supplier payment document (bankRuleAutoPostLine), and until now applied
-- none of it: the sweep ran unattended, so it took the supplier's
-- `auto_allocate_strategy`, whose default 'off' nobody ever changed. Hundreds
-- of rule-posted lines therefore left a processed payment against bills that
-- stayed wholly open.
--
-- The per-call mode (AUTO_APPLY_MODES, shared/autoAllocateStrategy.ts) is what
-- the attended paths now pass; a rule needs somewhere to keep the same
-- instruction, because there is no caller to ask. 'fifo' is the default here
-- for the same reason it is the default there: cash against a supplier's oldest
-- open bill is what the rule's author meant by the rule.
--
-- ON bank_categorisation_rules, NOT bank_rules. Both tables exist; the sweep
-- (bankRulesMatchingService), the CRUD service and the MCP list/get/update
-- tools ALL read bank_categorisation_rules, and `bank_rules` (migration 279)
-- holds zero rows and is read by no posting path. A column on the unused table
-- would look like the switch and change nothing.

ALTER TABLE bank_categorisation_rules
  ADD COLUMN IF NOT EXISTS auto_apply TEXT NOT NULL DEFAULT 'fifo';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_categorisation_rules_auto_apply_check'
  ) THEN
    ALTER TABLE bank_categorisation_rules
      ADD CONSTRAINT bank_categorisation_rules_auto_apply_check
      CHECK (auto_apply IN ('fifo', 'none'));
  END IF;
END $$;

COMMENT ON COLUMN bank_categorisation_rules.auto_apply IS
  'What an auto-posted supplier/customer line does with its cash: fifo applies it to the contact''s oldest open documents, none leaves it on account.';
