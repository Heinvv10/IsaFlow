-- Migration 600: reclassification batches.
--
-- `post_reclassification_batch` moves posted amounts from one GL account to
-- another by POSTING A NEW JOURNAL — DR target / CR source for the amount
-- moved, per source line, leaving the original lines exactly as posted.
-- Nothing here rewrites `gl_journal_lines.gl_account_id`, and nothing ever
-- should: a trial balance somebody has already signed must keep saying what it
-- said, and an auditor has to be able to see the original classification.
--
-- These two tables exist for two things the journal alone cannot say.
--
--   1. THE SET. A move off `49775627 Unallocated Expense` is 419 lines and,
--      dated to their own entry dates, some hundreds of journals. Undoing that
--      by hand means finding every one of them. The batch id names the set;
--      each journal is reversed through the ordinary `reverse_journal_entry`
--      path, which is what keeps the correction inside the audit trail rather
--      than beside it.
--
--   2. WHAT HAS ALREADY MOVED. `source_line_id` is what stops a line being
--      reclassified twice. `journal_entry_id`, paired with the batch's own
--      `source_account_id`, is what stops the CONTRA leg of a reclassification
--      being picked up as a candidate for a further one — which would move the
--      correction rather than the amount. Deliberately NOT recorded as a line
--      id: `createJournalEntry` returns no line ids, and `gl_journal_lines`
--      within one entry share a `created_at`, so any id recorded by position
--      would be a guess. The pair (this journal, that account) identifies the
--      contra legs exactly, from columns that already exist.
--
--      The TARGET leg of an earlier reclassification is deliberately NOT
--      excluded: an amount moved onto an account may legitimately be moved on
--      again, and refusing that would make the first move final.
--
-- created_by is text, matching bank_allocation_batches (mig 514) and
-- mcp_tool_calls: the MCP context carries the GoTrue subject as a string and
-- `users.id` is varchar(255), so there is no uuid FK to hang it on.
--
-- Append-only from the app (no UPDATE/DELETE grant). A reversal posts a contra
-- and leaves these rows standing as the record of what the batch did — a
-- deleted batch row would make a reversed reclassification look like one that
-- never happened.

-- LOCKING. The two REFERENCES below name `gl_journal_lines` and
-- `gl_journal_entries`, and a foreign key takes a SHARE ROW EXCLUSIVE lock on
-- the REFERENCED table for the duration of the CREATE TABLE. That conflicts
-- with the ROW EXCLUSIVE every INSERT holds, so this migration queues behind
-- in-flight postings and, once queued, blocks every new posting behind it.
--
-- No scan is needed — the new tables are empty and nothing is validated against
-- the referenced rows — so it is milliseconds ONCE ACQUIRED. The risk is
-- entirely the WAIT: behind one long-running transaction on the ledger, this
-- statement sits in the lock queue and every posting in the system sits behind
-- it. `lock_timeout` converts that from an outage into a failed migration you
-- re-run, which is the cheaper of the two mistakes.
--
-- The FKs are kept rather than dropped: these two columns are the only thing
-- tying a batch to what it actually moved, and an orphaned batch line would
-- make `already_reclassified` and the contra probe answer from rows whose
-- journals no longer exist.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS reclassification_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  tool text NOT NULL,
  source_account_id uuid NOT NULL REFERENCES gl_accounts(id),
  target_account_id uuid NOT NULL REFERENCES gl_accounts(id),
  line_count integer NOT NULL,
  posting_date date,
  idempotency_key text
);

CREATE INDEX IF NOT EXISTS reclassification_batches_company_created_idx
  ON reclassification_batches (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reclassification_batch_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  batch_id uuid NOT NULL REFERENCES reclassification_batches(id),
  -- The posted line whose amount was moved. NOT modified — referenced.
  source_line_id uuid NOT NULL REFERENCES gl_journal_lines(id),
  -- The reclassification journal this line's pair was posted into.
  journal_entry_id uuid NOT NULL REFERENCES gl_journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per source line per batch. A batch that tried to move the same line
-- twice is a defect the tool refuses pre-write; this is the database saying so
-- too, and it is the index the candidate query's `already_reclassified` probe
-- reads.
CREATE UNIQUE INDEX IF NOT EXISTS reclassification_batch_lines_uq
  ON reclassification_batch_lines (batch_id, source_line_id);

CREATE INDEX IF NOT EXISTS reclassification_batch_lines_company_source_idx
  ON reclassification_batch_lines (company_id, source_line_id);

-- The contra probe: "does this candidate line belong to a reclassification
-- journal?" Answered against this index, then narrowed by the batch's own
-- source_account_id.
CREATE INDEX IF NOT EXISTS reclassification_batch_lines_company_entry_idx
  ON reclassification_batch_lines (company_id, journal_entry_id);

CREATE INDEX IF NOT EXISTS reclassification_batch_lines_company_batch_idx
  ON reclassification_batch_lines (company_id, batch_id);

-- Tenant isolation — mirror of mig 514/515 (helpers from mig 348).
ALTER TABLE reclassification_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE reclassification_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON reclassification_batches;
CREATE POLICY tenant_isolation ON reclassification_batches
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT ON reclassification_batches TO app_user;

ALTER TABLE reclassification_batch_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE reclassification_batch_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON reclassification_batch_lines;
CREATE POLICY tenant_isolation ON reclassification_batch_lines
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT ON reclassification_batch_lines TO app_user;
