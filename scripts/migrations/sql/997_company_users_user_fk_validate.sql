-- 997: company_users.user_id -> users(id), step 2 of 2 (admin audit 2026-11-14, OP-2).
--
-- Validates company_users_user_id_fkey, which 996 added NOT VALID. From here every existing row
-- is proved to name a users row too, not only the rows written since 996.
--
-- Precondition: no orphan membership. Production's one orphan was deleted (Hein, 2026-11-15) and
-- this census read 0 there; run it again before the deploy:
--   SELECT count(*) FROM company_users cu
--    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cu.user_id);
-- If an orphan appears before the deploy, VALIDATE fails (23503, naming the user_id), this file
-- rolls back, and the deploy stops at its migrate step before any colour is switched. 996 stays
-- applied (its own file and transaction): the FK keeps refusing new orphans, NOT VALID, which the
-- running code was tested against. Delete the orphan, then rerun.
--
-- Idempotent: a constraint already validated is left alone. A missing constraint is an error, not
-- a skip: 996 runs first, so its absence means the schema is not what this file expects.
--
-- LOCKS. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on company_users and ROW SHARE on users:
-- it blocks neither table's reads or writes, only other DDL. It scans company_users (a few hundred
-- rows) once. lock_timeout bounds the wait behind other DDL; statement_timeout bounds the scan.
-- Either one firing rolls the file back: rerun it.
--
-- Rollback: none needed. A validated FK behaves as the NOT VALID one for every write; to undo both
-- steps, ALTER TABLE company_users DROP CONSTRAINT IF EXISTS company_users_user_id_fkey;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_validated boolean;
BEGIN
  SELECT convalidated INTO v_validated FROM pg_constraint
  WHERE conname = 'company_users_user_id_fkey' AND conrelid = 'public.company_users'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '997: company_users_user_id_fkey does not exist (996 must run first)';
  END IF;
  IF NOT v_validated THEN
    ALTER TABLE public.company_users VALIDATE CONSTRAINT company_users_user_id_fkey;
  END IF;
END $$;
