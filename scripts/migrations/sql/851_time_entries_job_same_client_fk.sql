-- 851_time_entries_job_same_client_fk.sql
-- A time entry's job must be a job of the SAME company and the SAME practice
-- client as the entry. The service fence (assertJobForPracticeClient) checks
-- this when an entry is written, but nothing stopped the JOB from moving to
-- another client afterwards: the entries then spent the new client's
-- Engagement Budget. This composite FK holds the pair in the database, and
-- ON UPDATE RESTRICT refuses moving a job whose entries are its current
-- client's (23503).
--
-- NOT VALID: enforced for every new or changed row; existing rows are not
-- re-checked here. VALIDATE CONSTRAINT is a separate, deliberate step after
-- this ships. Before it, count the rows it would refuse (must be 0):
--
--   SELECT count(*) FROM time_entries te
--   LEFT JOIN practice_jobs pj ON pj.id = te.job_id
--   WHERE te.job_id IS NOT NULL
--     AND te.practice_client_id IS NOT NULL  -- MATCH SIMPLE accepts a NULL in any column
--     AND (pj.id IS NULL
--          OR te.company_id IS DISTINCT FROM pj.company_id
--          OR te.practice_client_id IS DISTINCT FROM pj.practice_client_id);
--
-- then: ALTER TABLE time_entries VALIDATE CONSTRAINT time_entries_job_same_client_fkey;
--
-- MATCH SIMPLE: an entry with no job (job_id NULL) is not constrained.
--
-- The UNIQUE index build and both ALTERs take strong locks on practice_jobs and
-- time_entries; queued behind a long transaction they would block every
-- timesheet read, so fail instead (as 649, 717, 718).
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'practice_jobs_id_company_client_key' AND conrelid = 'practice_jobs'::regclass
  ) THEN
    ALTER TABLE practice_jobs
      ADD CONSTRAINT practice_jobs_id_company_client_key UNIQUE (id, company_id, practice_client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_entries_job_same_client_fkey' AND conrelid = 'time_entries'::regclass
  ) THEN
    ALTER TABLE time_entries
      ADD CONSTRAINT time_entries_job_same_client_fkey
      FOREIGN KEY (job_id, company_id, practice_client_id)
      REFERENCES practice_jobs (id, company_id, practice_client_id)
      ON UPDATE RESTRICT
      NOT VALID;
  END IF;
END $$;
