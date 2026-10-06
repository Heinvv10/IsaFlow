-- Migration 863: unique (group_id, adjustment_number) on consolidation_adjustments.
-- 2026-10-06 | fix/doc-number-races-20261006
--
-- consolidation_adjustments had no unique index on its number, so two concurrent inserts that the
-- numbering trigger gave the same number were both stored. Migration 858
-- serialises the trigger; this index refuses a duplicate from any other source
-- (an explicit number). Scope = exactly what the trigger numbers within.
--
-- Created only when the table holds no duplicate: CREATE UNIQUE INDEX fails
-- 23505 on an existing duplicate, and the EXCEPTION block turns that into a
-- NOTICE and leaves the table without the index, so existing data can never
-- fail a deploy. A NOTICE in the deploy log means: dedupe, then create the index
-- by hand with the statement below. (isaflow_dev, read 2026-10-06: no duplicate.)
-- NULL numbers never conflict in a unique index, so it is not partial.
--
-- One index per migration file: the runner (scripts/apply-migrations.ts) runs
-- each file in its own transaction, so this file holds only consolidation_adjustments's SHARE
-- lock, for the length of one index build, and never waits for another table
-- while holding it. lock_timeout bounds the wait to acquire it.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_consol_adj_group_number ON public.consolidation_adjustments (group_id, adjustment_number);
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '863: consolidation_adjustments holds a duplicate (group_id, adjustment_number); uq_consol_adj_group_number NOT created. Dedupe, then create it by hand (863_consolidation_adjustment_number_unique.sql)';
END $$;
