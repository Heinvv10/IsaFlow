-- K-108: approval_rules.condition_operator was a plain TEXT column with no
-- constraint. checkApproval can only evaluate 'any', 'greater_than' and
-- 'greater_equal'; any other value left the rule permanently unmatched, so a
-- rule the UI showed as active silently required no approval at all.
--
-- Added NOT VALID on purpose: rows written before this migration may already
-- carry an unrecognised operator, and failing the migration would leave the
-- column unconstrained for new writes too. New and updated rows are checked
-- from here on; the existing ones are enumerated by the impact query in
-- docs/audits/remediation/K-108/fix.md and handled by the fail-closed default
-- arm in checkApproval until they are corrected.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'approval_rules_condition_operator_check'
      AND conrelid = 'approval_rules'::regclass
  ) THEN
    ALTER TABLE approval_rules
      ADD CONSTRAINT approval_rules_condition_operator_check
      CHECK (condition_operator IN ('any', 'greater_than', 'greater_equal'))
      NOT VALID;
  END IF;
END $$;
