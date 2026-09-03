-- Migration 531: actor identity on credit notes; lock-safety notes for 530
--
-- Two findings from the blind review of migration 530.
--
-- 1. ACTOR COVERAGE WAS ASYMMETRIC WITH NO STATED REASON.
--    530 put external_ref on seven tables and actor_type on three, leaving
--    credit_notes with a source reference but no record of who raised it. That
--    gap is not harmless: create_credit_note writes a DRAFT row and no journal
--    until approval, so for the whole draft period the only trace of who
--    created it is the posting_agent on a journal that does not exist yet. A
--    credit note is the instrument that reduces a customer's debt — "who
--    raised this" is exactly the question an auditor asks about it.
--
--    The claim in docs/mcp/CONTRACTS.md is "actor identity on every write". It
--    is cheaper to make the schema match the claim than to narrow the claim.
--
-- 2. LOCK SAFETY IN 530 WAS INCIDENTAL, NOT DESIGNED.
--    530 adds a CHECK without NOT VALID and creates indexes without
--    CONCURRENTLY on gl_journal_entries — the table holding every journal in
--    the system. Both are effectively free THERE AND ONLY THERE, because the
--    columns they cover were added in the same migration and are NULL on every
--    existing row, so the validation scan and the index builds touch nothing.
--
--    That is a property of the data at that moment, not of the statements. The
--    same statements against a populated column take an ACCESS EXCLUSIVE lock
--    on gl_journal_entries for the length of a full scan, which on production
--    means every posting blocks. 530 cannot be edited — it has been applied and
--    an edit is a checksum conflict — so the warning lives here, next to the
--    only other place someone is likely to copy the pattern from.
--
--    IF YOU ARE COPYING THIS FILE: adding a constraint or an index to a column
--    that already holds data is a different operation. Use ADD CONSTRAINT ...
--    NOT VALID followed by a separate VALIDATE CONSTRAINT, and CREATE INDEX
--    CONCURRENTLY outside a transaction.
--
-- As with 530: no backfill. actor_type is NULL on every existing credit note
-- and is resolved from posting_agent at read time by resolveLegacyActorType(),
-- which reports such values as DERIVED and never as recorded.
--
-- No foreign key on actor_token_jti, and none on any actor column. `users.id`
-- is character varying(255) with a gen_random_uuid()::text default, not uuid,
-- so a uuid-typed FK to it fails at apply time. The established convention in
-- this schema is a bare column with no FK — company_groups.created_by and
-- intercompany_eliminations.created_by both do it that way.

ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS actor_token_jti TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_credit_notes_actor_type'
  ) THEN
    -- Safe without NOT VALID for the same reason as 530: the column is added
    -- immediately above and is NULL on every existing row, so the validation
    -- scan has nothing to check. See the note at the top before copying this.
    ALTER TABLE credit_notes
      ADD CONSTRAINT chk_credit_notes_actor_type
      CHECK (actor_type IS NULL OR actor_type IN ('human', 'agent', 'system'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_credit_notes_actor_token
  ON credit_notes (company_id, actor_token_jti) WHERE actor_token_jti IS NOT NULL;

COMMENT ON COLUMN credit_notes.actor_type IS
  'human | agent | system. NULL on rows written before migration 531 — resolve those from posting_agent at read time via resolveLegacyActorType, which reports them as derived, never recorded.';
COMMENT ON COLUMN credit_notes.actor_token_jti IS
  'PAT id or OAuth authorisation id that raised this credit note. NULL for human and system writes. No FK: users.id is varchar(255), not uuid.';
