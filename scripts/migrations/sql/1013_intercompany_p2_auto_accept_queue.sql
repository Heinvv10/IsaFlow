-- 1013: Intercompany P2 (invoice + credit-note mirror): the auto-accept worker's queue. Plan:
-- docs/plans/2026-11-17-intercompany-mirror-posting.md (P2, "Round 2": "the P2 auto-accept worker needs its own definer path").
--
-- WHAT. One SECURITY DEFINER function, intercompany_auto_accept_queue(p_limit): the pending invoice / credit-note messages
-- that the RECEIVER has asked to be accepted automatically, each with the receiver company and a write-role user of that
-- company whose claims the worker then acts with. Nothing else in the database changes (no table, column, index or policy).
--
-- WHY A DEFINER. The cron worker has no signed-in user and no company when it asks "what is waiting?": every RLS policy on
-- the intercompany tables is keyed to one session company, and intercompany_in_one_group (1002) answers only for a signed-in
-- party, so it is false when auth.uid() is NULL (and must stay so: it is no membership oracle). The queue is the one cross-tenant
-- READ the worker needs, and it must not be a general one. It therefore
--   - returns only message ids, receiver company ids and a user id (no payload, no names, no amounts);
--   - returns only a message whose RECEIVER side has auto_accept on, on an ACTIVE GROUP connection whose two companies still
--     share a current, active group (intercompany_shared_group: the membership re-check, at action time, on the same helper the
--     rest of the protocol uses);
--   - returns a user only when that user holds a write role (owner / admin / manager) in the receiver, is in good standing
--     (the allow-list withAuth applies: is_active, status 'active', not suspended) and the receiver company is live; a receiver
--     with no such user yields no row, so the worker never acts as nobody;
--   - is executable by app_service (the service pool's login) and migration_admin only: no tenant session (app_user) and not
--     the request pool's login can call it.
-- It does NOT write. The worker then opens a transaction as app_user with the claims of the returned user and the receiver
-- company's GUCs and does everything else (create the draft, mark the message accepted, link the documents) through the
-- receiver's own services under the receiver's own RLS and the guards of 1000 / 1002: there is no user-less write path.
--
-- DEFINER REGISTRY (930): registered in app_definer_reviews; owner migration_admin; search_path pinned, pg_temp last.
-- OLD COLOUR: nothing in the previous release calls it. LOCKS: a new function only.
--
-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_auto_accept_queue(integer);
--   DELETE FROM app_definer_reviews WHERE signature = 'intercompany_auto_accept_queue(integer)';

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.intercompany_auto_accept_queue(p_limit integer DEFAULT 50)
RETURNS TABLE (message_id uuid, to_company_id uuid, actor_user_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id, m.to_company_id, w.user_id
    FROM public.intercompany_messages m
    JOIN public.intercompany_connections c
      ON c.id = m.connection_id AND c.status = 'active' AND c.kind = 'group'
    JOIN public.intercompany_connection_sides s
      ON s.connection_id = m.connection_id AND s.company_id = m.to_company_id AND s.auto_accept
    JOIN public.companies rc
      ON rc.id = m.to_company_id
     AND rc.status IS DISTINCT FROM 'suspended' AND rc.status IS DISTINCT FROM 'deleted' AND rc.suspended_at IS NULL
    CROSS JOIN LATERAL (
      SELECT cu.user_id
        FROM public.company_users cu
        JOIN public.users u ON u.id = cu.user_id
       WHERE cu.company_id = m.to_company_id
         AND cu.role = ANY (ARRAY['owner', 'admin', 'manager'])
         AND u.is_active IS TRUE AND u.status = 'active' AND u.suspended_at IS NULL
       ORDER BY CASE cu.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cu.created_at, cu.user_id
       LIMIT 1
    ) w
   WHERE m.status = 'pending'
     AND m.kind IN ('invoice', 'credit_note')
     AND public.intercompany_shared_group(c.company_low_id, c.company_high_id)
   ORDER BY m.created_at, m.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;
ALTER FUNCTION public.intercompany_auto_accept_queue(integer) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_auto_accept_queue(integer) FROM app_user;
GRANT EXECUTE ON FUNCTION public.intercompany_auto_accept_queue(integer) TO app_service, migration_admin;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_auto_accept_queue(integer)', 'public.intercompany_auto_accept_queue(integer)',
     'nothing (read of intercompany_messages, intercompany_connections, intercompany_connection_sides, companies, company_users, users: the pending invoice / credit-note messages whose receiver side has auto_accept on an active group connection that still shares a current active group, with the receiver company and one write-role user in good standing; executable by app_service and migration_admin only)')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_auto_accept_queue(integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_auto_accept_queue(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '1013: a tenant role can execute intercompany_auto_accept_queue';
  END IF;
END $$;
