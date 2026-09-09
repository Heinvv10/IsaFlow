-- 660: a journal line may not name a GL account belonging to another company.
--
-- `gl_journal_lines_gl_account_id_fkey` references `gl_accounts(id)` ALONE, so a
-- line whose `company_id` is tenant A's and whose `gl_account_id` is tenant B's
-- satisfies every constraint on the table. RI checks bypass RLS, and the
-- WITH CHECK on `tenant_isolation` tests the LINE's company only, so nothing in
-- the database refused it. `createJournalEntry` — reached from
-- POST /api/accounting/journal-entries with caller-supplied `lines` — stamped
-- `company_id` from the session and `gl_account_id` from the request body, and
-- wrote exactly that row. Reproduced against a schema-identical database.
--
-- The composite FK makes the pair unrepresentable. `gl_accounts_id_company_uq`
-- UNIQUE (id, company_id) already exists, so no new index is needed on the
-- referenced side, and `idx_gl_jl_company_account` covers the referencing side.
--
-- NOT VALID on purpose: it enforces every INSERT and UPDATE from now on without
-- scanning the existing table, so the migration takes only a brief
-- ACCESS EXCLUSIVE lock and cannot fail on historical rows. Run the census in
-- docs/audits/remediation/K-051/fix.md first; VALIDATE CONSTRAINT (which takes
-- only a SHARE UPDATE EXCLUSIVE lock) is a separate, later decision once the
-- census returns zero.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'gl_journal_lines'::regclass
       AND conname = 'gl_journal_lines_account_company_fk'
  ) THEN
    ALTER TABLE gl_journal_lines
      ADD CONSTRAINT gl_journal_lines_account_company_fk
      FOREIGN KEY (gl_account_id, company_id)
      REFERENCES gl_accounts (id, company_id)
      NOT VALID;
  END IF;
END $$;
