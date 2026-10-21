-- 908 — relabel the Sage LIVE journal history that scripts/import-sage-britech.ts
-- wrote as source 'auto_migration'. Label only, and recorded.
--
-- WHY. 'auto_migration' is the source every take-on / opening-balance writer
-- uses, and readers take it to mean exactly that: both statements of changes
-- in equity and the AFS dividends line read it as a balance carried in
-- (gl/takeOnJournalSource.ts), the bank opening-balance read
-- (openingBalanceReadService) counts its bank lines as the posted opening
-- balance, and the migration residual check (migrationService) reads it on
-- Opening Balance Equity. The Britech import script also wrote Sage's
-- day-to-day journals with it (card spends, corrections, monthly expense
-- journals), so every one of those readers took live history for a take-on.
-- The script now writes 'auto_gl_import' (PR #768); this relabels what it
-- wrote before.
--
-- WHAT IS MATCHED, and why it is safe on data nobody has looked at:
--   * only the script's company, d27bac33-cdc0-4e58-bf6b-709c1597d41c, which it
--     hardcodes (its CID): no other company was ever written by it, and no
--     other writer numbers journals 'SAGE-<n>' (every other insert leaves the
--     number to trg_gl_je_entry_number, 'JE-...');
--   * source 'auto_migration' and entry number 'SAGE-<n>';
--   * NOT Sage's own opening balances, which ARE a take-on: a description of
--     'O/B from other system' (any case, trailing punctuation or spaces
--     ignored) or a reference 'O/balance' / 'O/B';
--   * and every reversal of a relabelled journal, at any depth, in that
--     company (reverseJournalEntry copies the source; a reversal is numbered
--     'JE-...', so it is found through reversal_of_id, not its number).
--
-- ON DEV (isaflow_dev, 2026-10-21): 54 Sage journals, 2023-02-28 to
-- 2025-08-31, none reversed; 8 kept (all 'O/B from other system', 2023-02-28,
-- references 'O/balance' x6, 'O/B' x2), 46 relabelled. Production not inspected.
--
-- RECORDED like 855's migration-time correction: one audit_log row per
-- relabelled journal ('update' of gl_journal_entry, the field before and
-- after, the reason and this file), by the user whose import wrote it. A
-- forensic comparison against a snapshot sealed before this ran shows each of
-- them as a changed journal (source auto_migration -> auto_gl_import), and the
-- audit trail carries why. A journal whose author is not a user refuses the
-- migration rather than go unrecorded.
--
-- LABEL ONLY: `source` is the one column written (trg_gl_je_updated_at bumps
-- updated_at). No amount, date, status, line or period changes; the balance
-- trigger fires on a status change only. Idempotent: a relabelled journal no
-- longer matches, so a re-run writes nothing and records nothing.
--
-- ROW SECURITY: gl_journal_entries and audit_log FORCE RLS. row_security is
-- turned off for this transaction (as 855 does), so a role subject to RLS gets
-- an error ("query would be affected by row-level security policy") instead of
-- matching, relabelling and counting nothing and passing. It applies as the
-- owner, a superuser or a BYPASSRLS role.
--
-- Rollback: set source back to 'auto_migration' on the journals the audit_log
-- rows of this file name (entity_ref, changes->'metadata'->>'migration').

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  v_company constant uuid := 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
  v_relabelled integer;
  v_kept integer;
  v_left integer;
BEGIN
  PERFORM set_config('row_security', 'off', true);

  CREATE TEMP TABLE IF NOT EXISTS tmp_908 (id uuid PRIMARY KEY, company_id uuid NOT NULL, created_by uuid) ON COMMIT DROP;
  TRUNCATE tmp_908;

  WITH RECURSIVE history AS (
    SELECT je.id, je.company_id, je.created_by
      FROM gl_journal_entries je
     WHERE je.company_id = v_company
       AND je.source = 'auto_migration'
       AND je.entry_number LIKE 'SAGE-%'
       AND lower(rtrim(COALESCE(je.description, ''), ' .,;:!')) <> 'o/b from other system'
       AND COALESCE(btrim(je.reference), '') NOT IN ('O/balance', 'O/B')
    UNION
    -- Reversals of a relabelled journal, at any depth, in the same company.
    SELECT r.id, r.company_id, r.created_by
      FROM gl_journal_entries r
      JOIN history h ON r.reversal_of_id = h.id AND r.company_id = h.company_id
     WHERE r.source = 'auto_migration'
  )
  INSERT INTO tmp_908 (id, company_id, created_by)
  SELECT DISTINCT id, company_id, created_by FROM history;

  IF EXISTS (SELECT 1 FROM tmp_908 t WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.created_by::text)) THEN
    RAISE EXCEPTION 'migration 908: a journal to relabel has no author in users, so its change cannot be recorded';
  END IF;

  INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, entity_ref, changes)
  SELECT t.company_id, t.created_by::text, 'update', 'gl_journal_entry', t.id, je.entry_number,
         jsonb_build_object(
           'fields', jsonb_build_array(jsonb_build_object(
             'field', 'source', 'label', 'Source', 'old', 'auto_migration', 'new', 'auto_gl_import')),
           'metadata', jsonb_build_object(
             'reason', 'Sage live history imported by scripts/import-sage-britech.ts, relabelled from take-on to GL import',
             'migration', '908_relabel_sage_history_journals.sql'))
    FROM tmp_908 t
    JOIN gl_journal_entries je ON je.id = t.id AND je.company_id = t.company_id;

  UPDATE gl_journal_entries je
     SET source = 'auto_gl_import'
    FROM tmp_908 t
   WHERE je.id = t.id
     AND je.company_id = t.company_id
     AND je.source = 'auto_migration';
  GET DIAGNOSTICS v_relabelled = ROW_COUNT;
  IF v_relabelled <> (SELECT count(*) FROM tmp_908) THEN
    RAISE EXCEPTION 'migration 908: % journals matched but % were relabelled', (SELECT count(*) FROM tmp_908), v_relabelled;
  END IF;

  -- Nothing the predicate names is left behind: no Sage history journal, and
  -- no reversal of one at any depth, still carries auto_migration. Counted
  -- with row_security off, so a role RLS would filter errors here too.
  WITH RECURSIVE gone AS (
    SELECT je.id, je.company_id
      FROM gl_journal_entries je
     WHERE je.company_id = v_company
       AND je.entry_number LIKE 'SAGE-%'
       AND lower(rtrim(COALESCE(je.description, ''), ' .,;:!')) <> 'o/b from other system'
       AND COALESCE(btrim(je.reference), '') NOT IN ('O/balance', 'O/B')
    UNION
    SELECT r.id, r.company_id
      FROM gl_journal_entries r
      JOIN gone g ON r.reversal_of_id = g.id AND r.company_id = g.company_id
  )
  SELECT count(*) INTO v_left
    FROM gone g JOIN gl_journal_entries je ON je.id = g.id
   WHERE je.source = 'auto_migration';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'migration 908: % Sage history journals or reversals of them still carry auto_migration', v_left;
  END IF;

  SELECT count(*) INTO v_kept
    FROM gl_journal_entries je
   WHERE je.company_id = v_company AND je.source = 'auto_migration' AND je.entry_number LIKE 'SAGE-%';
  RAISE NOTICE 'migration 908: company %: % Sage history journals (reversals included) relabelled auto_gl_import, % Sage opening balances kept auto_migration',
    v_company, v_relabelled, v_kept;
END $$;
