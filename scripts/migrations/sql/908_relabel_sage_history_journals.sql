-- 908 — relabel the Sage LIVE journal history that scripts/import-sage-britech.ts
-- wrote as source 'auto_migration'. Label only.
--
-- WHY. 'auto_migration' is the source every take-on / opening-balance writer
-- uses, and readers take it to mean exactly that: the report statement of
-- changes in equity puts its equity postings on "Balances taken on" and the AFS
-- SOCE leaves its dividends out of dividends paid (gl/takeOnJournalSource.ts),
-- the bank opening-balance read (openingBalanceReadService) counts its bank
-- lines as the posted opening balance, and the migration residual check
-- (migrationService) reads it on Opening Balance Equity. The Britech import
-- script also wrote Sage's day-to-day journals with it (card spends,
-- corrections, monthly expense journals), so every one of those readers took
-- live history for a take-on. The script now writes 'auto_gl_import' (PR #768);
-- this relabels what it wrote before.
--
-- WHAT IS MATCHED. Journals with source 'auto_migration' and an entry number
-- 'SAGE-<n>'. Only that script writes such numbers: every other writer leaves
-- entry_number to trg_gl_je_entry_number ('JE-...'), and the writers of
-- 'auto_migration' are pinned by tests/unit/services/afs/takeOnJournalWriterCensus.
-- KEPT as 'auto_migration': Sage's own opening-balance journals among them,
-- the ones Sage describes exactly as 'O/B from other system' (Sage's text for
-- balances brought from a previous system), which ARE a take-on. Reversals copy
-- their original's source (reverseJournalEntry), so a reversal — at any depth —
-- of a relabelled journal is relabelled with it, and one of a kept journal kept.
--
-- ON DEV (isaflow_dev, 2026-10-21): 54 matched journals, all Brightsphere
-- Technologies (Pty) Ltd, 2023-02-28 to 2025-08-31, none with reversals;
-- 8 kept ('O/B from other system', 2023-02-28, references 'O/balance' x6 and
-- 'O/B' x2), 46 relabelled. Production has not been inspected; the predicate
-- names the script's own numbering and source, so it matches nothing else.
--
-- LABEL ONLY: `source` is the one column written (trg_gl_je_updated_at bumps
-- updated_at). No amount, date, status, line or period changes; the balance
-- trigger fires on a status change only, and gl_journal_entries carries no
-- immutability or audit trigger. Every statement names company_id through the
-- matched row: a reversal is relabelled only within its original's company.
-- Idempotent: once relabelled a journal no longer matches.
--
-- Rollback: the same predicate with the labels swapped — journals with source
-- 'auto_gl_import', an entry number 'SAGE-<n>' and a description other than
-- 'O/B from other system', plus their reversals, back to 'auto_migration'.
-- (Journals the script writes from now on carry 'auto_gl_import' too; leave
-- those out by created_at if any exist.)

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  v_updated integer;
  v_left    integer;
BEGIN
  WITH RECURSIVE history AS (
    SELECT je.id, je.company_id
      FROM gl_journal_entries je
     WHERE je.source = 'auto_migration'
       AND je.entry_number LIKE 'SAGE-%'
       AND btrim(COALESCE(je.description, '')) <> 'O/B from other system'
    UNION
    -- Reversals of a relabelled journal, at any depth, in the same company.
    SELECT r.id, r.company_id
      FROM gl_journal_entries r
      JOIN history h ON r.reversal_of_id = h.id AND r.company_id = h.company_id
     WHERE r.source = 'auto_migration'
  )
  UPDATE gl_journal_entries je
     SET source = 'auto_gl_import'
    FROM (SELECT DISTINCT id, company_id FROM history) t
   WHERE je.id = t.id
     AND je.company_id = t.company_id
     AND je.source = 'auto_migration';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Nothing the predicate names is left behind: no Sage history journal, and
  -- no reversal of a relabelled one, still carries auto_migration.
  SELECT count(*) INTO v_left
    FROM gl_journal_entries je
   WHERE je.source = 'auto_migration'
     AND ((je.entry_number LIKE 'SAGE-%' AND btrim(COALESCE(je.description, '')) <> 'O/B from other system')
       OR EXISTS (SELECT 1 FROM gl_journal_entries o
                   WHERE o.id = je.reversal_of_id AND o.company_id = je.company_id AND o.source = 'auto_gl_import'
                     AND o.entry_number LIKE 'SAGE-%'));
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'migration 908: % Sage history journals or their reversals still carry auto_migration', v_left;
  END IF;

  RAISE NOTICE 'migration 908: relabelled % Sage history journals (reversals included) to auto_gl_import', v_updated;
END $$;
