-- 996: company_users.user_id -> users(id), step 1 of 2 (admin audit 2026-11-14, OP-2).
--
-- company_users.user_id carried no foreign key, so a membership could name a user that does not
-- exist (withAuth then refuses it as MISSING_PROFILE) and could outlive the user it named. Code
-- worked around the gap: addUserToCompany holds the users row FOR KEY SHARE, deleteUser sweeps
-- memberships again after deleting the user.
--
-- NOT VALID: existing rows are not checked and the table is not scanned, so a row already orphaned
-- cannot fail the deploy. Production holds one today (a Demo company owner membership whose user
-- row is gone). Every row inserted, or updated in user_id, from now on is checked. Step 2 is a
-- later migration, ALTER TABLE company_users VALIDATE CONSTRAINT company_users_user_id_fkey, once
-- this census reads 0 on production:
--   SELECT count(*) FROM company_users cu
--    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cu.user_id);
--
-- DEFERRABLE INITIALLY DEFERRED: checked at COMMIT, not per statement. The tenant writers insert
-- the membership BEFORE the users row in one transaction (tenantProvisioningService.provisionTenant;
-- POST /api/invitations/[token]/accept for a new member), the lock order the admin user actions
-- keep (company_users, then users). deleteUser deletes the users row and then sweeps a membership
-- a concurrent add-to-company committed meanwhile; checked per statement, that DELETE would be
-- refused instead of swept. At COMMIT each of them holds.
--
-- ON DELETE / ON UPDATE: NO ACTION (the default). Deleting a user that a membership still names is
-- refused; deleteUser removes the memberships first. users.id is varchar(255), user_id text: the
-- text equality operator serves both, so no cast and no rewrite. idx_company_users_user covers the
-- lookup a users DELETE makes.
--
-- LOCKS. ADD FOREIGN KEY ... NOT VALID takes SHARE ROW EXCLUSIVE on company_users and then on users
-- (blocks their writes, not reads; no scan), held to COMMIT because apply-migrations.ts runs the
-- file in one transaction: company_users first, users second, the order every writer takes them.
-- If lock_timeout trips (a writer held either table for more than 5 s), the file rolls back and
-- nothing is recorded: rerun it. The constraint is added only when pg_constraint does not already
-- hold it, so a rerun changes nothing.
--
-- Rollback: ALTER TABLE company_users DROP CONSTRAINT IF EXISTS company_users_user_id_fkey;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_users_user_id_fkey' AND conrelid = 'public.company_users'::regclass
  ) THEN
    ALTER TABLE public.company_users ADD CONSTRAINT company_users_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
END $$;
