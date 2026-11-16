-- 997c: deleting a user who sent invitations no longer fails (admin follow-up, Hein 2026-11-16).
--
-- company_invitations.invited_by was varchar(255) NOT NULL with company_invitations_invited_by_fkey
-- -> users(id), NO ACTION. Deleting any user who had ever sent an invitation (deleteUser, DELETE
-- /api/admin/users/<id>) was refused (23503), answered 500, and deleted nothing. Decision: the
-- invitation keeps everything except who sent it. invited_by becomes nullable and the FK
-- ON DELETE SET NULL. A pending invitation stays acceptable by its invitee; readers show no sender
-- (GET /api/invite/<token> already says 'Someone').
--
-- The SET NULL runs inside the users DELETE, as the owner of company_invitations (Postgres runs a
-- referential action as the referencing table's owner, with that table's row security off), not as
-- the deleting session's role. So company_invitations_role_guard (883/886/916), which refuses every
-- write by platform_admin (RC008), sees the owner and lets it through, as it lets every role through
-- that is neither app_user nor an app_service holder without BYPASSRLS. The table's change history
-- records each changed row. Pinned by tests/integration/invited-by-set-null.int.test.ts.
--
-- LOCKS. One transaction (apply-migrations.ts): DROP NOT NULL takes ACCESS EXCLUSIVE on
-- company_invitations (catalog only, no scan); replacing the FK takes company_invitations and then
-- users, and the new FK is checked once by one query over company_invitations (one row per
-- invitation ever sent: a small table; every non-NULL value already satisfies the old FK on the same
-- column, so the check cannot fail). NOT VALID plus a later VALIDATE would buy nothing here: the
-- old constraint is dropped and the new one added under the same lock in this file. lock_timeout
-- 5 s: a writer holding either table longer makes the file roll back with nothing recorded; rerun it.
--
-- Idempotent: the FK is replaced only when pg_constraint does not already hold it with
-- ON DELETE SET NULL on invited_by -> users(id); DROP NOT NULL is a no-op when already nullable. The
-- last block refuses the migration unless the end state is exactly that.
--
-- Rollback (only while no invitation has a NULL invited_by): restore NOT NULL and the NO ACTION FK.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.company_invitations ALTER COLUMN invited_by DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conname = 'company_invitations_invited_by_fkey'
       AND c.conrelid = 'public.company_invitations'::pg_catalog.regclass
       AND c.contype = 'f'
       AND c.confrelid = 'public.users'::pg_catalog.regclass
       AND c.confdeltype = 'n'
       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                              WHERE a.attrelid = 'public.company_invitations'::pg_catalog.regclass
                                AND a.attname = 'invited_by')]::pg_catalog.int2[]
  ) THEN
    ALTER TABLE public.company_invitations DROP CONSTRAINT IF EXISTS company_invitations_invited_by_fkey;
    ALTER TABLE public.company_invitations ADD CONSTRAINT company_invitations_invited_by_fkey
      FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT a.attnotnull FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.company_invitations'::pg_catalog.regclass AND a.attname = 'invited_by') THEN
    RAISE EXCEPTION '997c: company_invitations.invited_by is still NOT NULL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conname = 'company_invitations_invited_by_fkey'
       AND c.conrelid = 'public.company_invitations'::pg_catalog.regclass
       AND c.confrelid = 'public.users'::pg_catalog.regclass
       AND c.confdeltype = 'n' AND c.convalidated
  ) THEN
    RAISE EXCEPTION '997c: company_invitations_invited_by_fkey is not a validated ON DELETE SET NULL FK to users(id)';
  END IF;
END $$;
