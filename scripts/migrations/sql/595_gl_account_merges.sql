-- Migration 595: record what a GL account merge actually moved.
--
-- `merge_gl_accounts` repoints every journal line from one account to another
-- and deactivates the source. Before this table the only record of a merge was
-- `mcp_tool_calls.result`, which stores a COUNT, beside an `args_hash` that is
-- a sha256 and therefore does not give the arguments back either. The single
-- forensic handle was `gl_journal_lines.updated_at` falling inside the tool
-- call's window — undocumented, unindexed, and destroyed by the next write to
-- those rows.
--
-- That made a wrong merge unrecoverable in practice. Merging back does NOT undo
-- it: a reverse merge moves the TARGET's original lines too, so the two
-- populations the first merge fused stay fused. Only the identity of the lines
-- that moved can separate them again, and that is what this stores.
--
-- The line ids live in a `uuid[]` rather than a child table on purpose: they are
-- written once, read whole, and never joined against. Velocity's largest
-- candidate merge is 3,669 lines, roughly 59KB in the array.
--
-- No foreign key on `merged_by`: `users.id` is `character varying(255)` with a
-- `gen_random_uuid()::text` default, so a uuid-typed FK to it fails at apply
-- time. TEXT, unconstrained, as everywhere else in this schema.

CREATE TABLE IF NOT EXISTS gl_account_merges (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID NOT NULL REFERENCES companies(id),
  source_account_id         UUID NOT NULL REFERENCES gl_accounts(id),
  target_account_id         UUID NOT NULL REFERENCES gl_accounts(id),
  -- Codes as they stood at merge time. The source keeps its code afterwards,
  -- but a later rename would otherwise make the record unreadable.
  source_account_code       VARCHAR(20) NOT NULL,
  target_account_code       VARCHAR(20) NOT NULL,
  source_account_subtype    VARCHAR(50),
  target_account_subtype    VARCHAR(50),
  lines_repointed           INTEGER NOT NULL,
  entries_affected          INTEGER NOT NULL,
  -- The moved lines, in the order the preview reported them. This is the whole
  -- point of the table: it is what a reversal would need.
  moved_line_ids            UUID[] NOT NULL,
  -- sha256 over the same ids, joined by newline. Small enough to appear in the
  -- dry run, so the document a human signs COMMITS to a specific set of lines
  -- even when the printed sample is capped.
  moved_line_ids_digest     TEXT NOT NULL,
  -- The tree work, so a reversal can put the children back where they were.
  reparented_account_ids    UUID[] NOT NULL DEFAULT '{}',
  relevelled_account_ids    UUID[] NOT NULL DEFAULT '{}',
  level_delta               INTEGER NOT NULL DEFAULT 0,
  merged_by                 TEXT,
  actor_type                TEXT,
  actor_token_jti           TEXT,
  posted_through            TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gl_account_merges_company
  ON gl_account_merges (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gl_account_merges_source
  ON gl_account_merges (company_id, source_account_id);
