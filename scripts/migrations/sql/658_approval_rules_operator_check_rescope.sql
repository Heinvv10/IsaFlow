-- K-043 (round-3 review HIGH-1): 647 was edited in place after it had already
-- been applied, and its guard tests the constraint's NAME, never its
-- DEFINITION. A database that ran the earlier form of 647 — or the
-- 632_approval_rules_condition_operator_check.sql the rename replaced — already
-- carries a constraint by that exact name, so re-running 647 is a no-op and the
-- UNSCOPED CHECK survives forever.
--
-- That matters because the scoping is what lets a legacy rule be switched off.
-- updateRule re-presents condition_operator through COALESCE, and PostgreSQL
-- enforces a NOT VALID CHECK on every row it UPDATES, so under the unscoped
-- form `is_active = false` on a rule carrying an unreadable operator raises
-- 23514 — and checkApproval now fails CLOSED, which makes exactly those rules
-- demand approval on every document of their type. The route tells the user to
-- "deactivate it or set a valid operator"; on such a database neither works.
--
-- This migration is idempotent by DEFINITION, not by name: it drops whatever
-- constraint of that name does not mention is_active and adds the scoped one.
-- Running it on a database that already has the scoped form changes nothing.
--
-- OPERATORS: a database that applied the PRE-EDIT 647 will fail
-- scripts/apply-migrations.ts on a checksum mismatch for 647 before reaching
-- this file. Clear that with scripts/migrations/resolve-checksum-conflicts.ts
-- first; 658 then repairs the constraint itself.

DO $$
DECLARE
  existing_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_def
  FROM pg_constraint
  WHERE conname = 'approval_rules_condition_operator_check'
    AND conrelid = 'approval_rules'::regclass;

  -- Any form that does not consult is_active is the pre-edit one.
  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%is_active%' THEN
    ALTER TABLE approval_rules DROP CONSTRAINT approval_rules_condition_operator_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE approval_rules
      ADD CONSTRAINT approval_rules_condition_operator_check
      CHECK (condition_operator IN ('any', 'greater_than', 'greater_equal')
             OR is_active IS NOT TRUE)
      NOT VALID;
  END IF;
END $$;
