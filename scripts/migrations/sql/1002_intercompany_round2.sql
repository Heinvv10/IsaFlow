-- 1002: Intercompany P1 review round 2, on top of 1000_intercompany_connections (a forward migration: 1000 is not edited).
-- Plan: docs/plans/2026-11-17-intercompany-mirror-posting.md ("Round 2").
--
-- Applies cleanly on top of 1000 whether or not 1000 already holds rows: it adds functions, triggers and indexes, replaces
-- function bodies (CREATE OR REPLACE) and index definitions, adds no column and drops none (the moved pair settings are already
-- on intercompany_connections in 1000), and every statement is idempotent (it can be applied twice).
--
-- WHAT CHANGES
--   - Viewers read only: every app_user write on the five tables needs intercompany_user_can_write(<acting company>) in the
--     table's guard (status changes, sides, sending and handling a message, links, keys). New: intercompany_keys_guard.
--   - Group membership holds for the life of a group connection and the group must be ACTIVE (company_groups.is_active, which
--     deleteGroup clears). intercompany_shared_group (internal, migration_admin only) holds the check; intercompany_in_one_group
--     (SECURITY DEFINER) answers only for a party, so it is no membership oracle. Triggers on company_group_members (existing)
--     and company_groups (new: is_active, DELETE) revoke the active group connections whose companies no longer share a current
--     active group. The system revocation is accepted by the connections guard only from migration_admin with the
--     transaction-local flag app.intercompany_system_revoke (replaces the pg_trigger_depth() test).
--   - A revoked connection releases its sides' customer and supplier links (SECURITY DEFINER intercompany_release_links, trigger
--     on the connection's status), so the partial unique indexes do not hold a customer or supplier on a dead connection.
--   - Sides: a foreign key's ON DELETE SET NULL (one trigger level down, references going to NULL only) passes the guard whatever
--     the connection's state; supersedes 1000's narrower revoked-only exemption.
--   - Messages: an invoice / credit_note / interest_invoice names a source document that exists in the SENDING company and fits
--     its kind (invoice, interest_invoice: a customer invoice; credit_note: a customer credit note); accepting one names a target
--     that exists in the RECEIVING company and fits it (a supplier invoice; a supplier credit note); a kind that creates no
--     document (payment, allocation, reject, credit_request) carries no target (cleared); accept, reject and restore need an
--     active connection; handled_via 'auto' only with the receiver's auto_accept on an active group connection.
--   - Links: confirming needs an active connection and the confirmed side's document in its company
--     (intercompany_document_exists_as_writer, a registered definer); a pending pairing holds no unique slot (indexes over ACTIVE
--     links); one mirror link per message; the mirror match is NULL-safe and re-checks, for a message that creates a document,
--     that both documents belong to the message's two companies (intercompany_message_documents_ok, a registered definer).
--   - ONE LOCK PROTOCOL for "do these two companies share a group" (READ COMMITTED; every check is stale by the time its writer
--     commits, and two concurrent leaves each see the other's change uncommitted, so neither revokes). The lock is a ROW LOCK on the
--     single row of intercompany_topology_lock, a table no app role can touch (an advisory lock would do the same, but its key is
--     public and app_user may take it for the length of its connection, stalling every tenant):
--       * every path that DECIDES on the strength of the group (a connection created or re-activated, auto-accept switched on, a
--         message sent: all go through intercompany_in_one_group, a definer) takes the row FOR SHARE, and only after the party
--         check (a stranger takes nothing), then reads membership. It holds the lock to commit.
--       * every path that CHANGES the topology (a membership's left_date / company / group changed or deleted, a group's is_active
--         cleared or the group deleted: intercompany_group_membership_changed, a definer) takes it FOR UPDATE, then re-reads
--         membership and revokes what no longer shares a group. It therefore waits for in-flight writers (and then revokes what they
--         created), a writer that comes second waits and then sees the change, and two leaves serialise: the second one sees the first.
--       * ORDER (the only one): (1) the revoking trigger locks the candidate connections FOR NO KEY UPDATE (by id), then their sides
--         rows FOR NO KEY UPDATE (by connection, company); (2) the topology row; (3) the rows the revocation updates. Every other
--         path takes the same locks in a subsequence of that order: a re-activation holds its connection row, then waits for the
--         topology row (the revoking trigger only updates rows that are not 'revoked' in its post-lock snapshot, so it never waits on
--         that row); a session switching auto-accept on holds its side row, then waits for the topology row; a side's first save, a
--         message sent or accepted and a link inserted hold their connection row FOR SHARE (the connection guards), then the topology
--         row where they need it. A manual revoke (a user UPDATE of the status) holds the connection row, then the release trigger
--         takes the sides rows: also in that order. (Row locks are queued per row, so a steady stream of overlapping deciders can
--         keep a leave waiting; each decider's transaction is a few statements.)
--       * the lock is ONE row for the whole topology, not one per pair: a leave is a rare admin act, and it needs no pair
--         enumeration (a pair whose connection is being created is invisible to a scan, which made per-pair locking leaky). Its
--         scope is therefore cross-tenant: a leave in company X's group waits for every in-flight decider of every tenant, and
--         every decider waits behind a leave in flight. Both are a few statements long.
--       * limits: a statement that changes SEVERAL membership rows at once fires its row triggers one at a time (each takes and
--         keeps the lock, so it is safe, but two such statements over the same rows in opposite orders can deadlock: one gets
--         40P01 and rolls back, nothing is corrupted); a session that, inside ONE transaction, holds the shared lock and then
--         updates a side or connection row that an in-flight leave holds (accept a message, then send one, in one transaction)
--         ends in 40P01 only; and a connection that is committed between the revoking trigger's scan and its lock, with a side being
--         updated in that same instant, can do the same. A deadlock rolls its whole transaction back.
--   - A document is the target of ONE accepted message per RECEIVING COMPANY, whatever the connection (index
--     intercompany_messages_target_uq and the guard), and an ACTIVE link per company document position (doc_a per company A, doc_b
--     per company B, whatever the connection). A company that is the LOW company of one connection and the HIGH of another can hold
--     the same document as doc_a on one and doc_b on the other: no index spans the two positions, so only the message rule (one
--     accepted message per target, one mirror link per message) covers mirror links; two manual pairings are not covered.
--   - A sides first save (INSERT), a message send and a link insert read their connection FOR SHARE (as accepting a message does),
--     so a revoke in flight, manual or by the system, is waited for and seen: nothing is saved on a revoked connection.
--   - The sides guard's depth >= 2 exemption (a foreign key's SET NULL action and the release trigger) trusts any trigger nesting;
--     it is defence in depth that rests on migration 945 (REVOKE TEMPORARY FROM PUBLIC: no app_user can create the temp table a
--     nested trigger would need) staying applied.
--   - A revoked connection also switches its sides' auto_accept off; a no-op status UPDATE needs the same write role as a change.
--   - Backfill for rows 1000 may already hold: group connections whose group is gone are revoked (stamp system:group-membership),
--     and revoked connections release their customer and supplier links and auto-accept (by a no-op status UPDATE, as the system
--     path, that fires the release trigger).
--
-- DEFINER FUNCTIONS (registered in app_definer_reviews, 930; owner migration_admin; pinned search_path, pg_temp last; EXECUTE for
-- app_user and app_service only, none for the trigger functions): intercompany_in_one_group (reads, and takes the topology row FOR SHARE),
-- intercompany_document_exists_as_writer, intercompany_message_documents_ok (reads); intercompany_group_membership_changed,
-- intercompany_release_links (trigger functions, write). 1000 registered the first and the fourth; their rows are updated here.
--
-- Rollback (code first; 1000's behaviour returns only by re-applying its function bodies):
--   DROP INDEX IF EXISTS intercompany_messages_target_uq;
--   DROP TRIGGER IF EXISTS trg_intercompany_release_links ON intercompany_connections;
--   DROP TRIGGER IF EXISTS trg_intercompany_group_deactivated ON company_groups;
--   DROP TRIGGER IF EXISTS trg_intercompany_keys_guard ON company_connection_keys;
--   DROP FUNCTION IF EXISTS public.intercompany_release_links(), public.intercompany_keys_guard(),
--     public.intercompany_document_exists_as_writer(text, uuid, uuid), public.intercompany_message_documents_ok(uuid),
--     public.intercompany_message_doc_exists(text, text, text, uuid, uuid), public.intercompany_shared_group(uuid, uuid);
--   DROP TABLE IF EXISTS public.intercompany_topology_lock;
--   DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_document_exists_as_writer(text,uuid,uuid)',
--     'intercompany_message_documents_ok(uuid)', 'intercompany_release_links()');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 0. The topology lock: one row, no app role can touch it ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.intercompany_topology_lock (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id)
);
INSERT INTO public.intercompany_topology_lock (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.intercompany_topology_lock OWNER TO migration_admin;
ALTER TABLE public.intercompany_topology_lock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intercompany_topology_lock FROM PUBLIC, app_user, app_service;
COMMENT ON TABLE public.intercompany_topology_lock IS
  'One row, locked FOR SHARE by intercompany_in_one_group and FOR UPDATE by the group-membership revoking trigger (both definers of migration_admin): serialises decisions on group membership. No app role has any privilege on it. See migration 1002.';

-- ── 1. Link indexes: unique over ACTIVE links only, one mirror link per message ─────────────

-- A document is in one ACTIVE link per company position, and the receiver's document is the target of one accepted message per
-- receiving company, WHATEVER the connection (a second connection of the company, or a revoked pair's replacement, must not
-- hold the same document again). Both would fail on duplicate data, so check first and name the rows.
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(format('active link documents %s %s of company %s: links %s', d.t, d.doc, d.company, d.ids), '; ')
    INTO dup
    FROM (SELECT 'doc_a' AS pos, company_a_id AS company, doc_a_type AS t, doc_a_id AS doc, string_agg(id::text, ',') AS ids
            FROM public.intercompany_document_links WHERE status = 'active'
           GROUP BY company_a_id, doc_a_type, doc_a_id HAVING count(*) > 1
          UNION ALL
          SELECT 'doc_b', company_b_id, doc_b_type, doc_b_id, string_agg(id::text, ',')
            FROM public.intercompany_document_links WHERE status = 'active'
           GROUP BY company_b_id, doc_b_type, doc_b_id HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '1002: cannot make active links unique per company document, duplicates exist (unlink all but one first): %', left(dup, 1500);
  END IF;
  SELECT string_agg(format('target %s %s of company %s: messages %s', d.t, d.doc, d.company, d.ids), '; ')
    INTO dup
    FROM (SELECT to_company_id AS company, target_doc_type AS t, target_doc_id AS doc, string_agg(id::text, ',') AS ids
            FROM public.intercompany_messages WHERE status = 'accepted' AND target_doc_id IS NOT NULL
           GROUP BY to_company_id, target_doc_type, target_doc_id HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '1002: cannot make accepted message targets unique per receiving company, duplicates exist (one message per document must stay accepted): %', left(dup, 1500);
  END IF;
END $$;

DROP INDEX IF EXISTS public.intercompany_links_doc_a_live;
DROP INDEX IF EXISTS public.intercompany_links_doc_b_live;
DROP INDEX IF EXISTS public.intercompany_links_doc_a_active;
DROP INDEX IF EXISTS public.intercompany_links_doc_b_active;
DROP INDEX IF EXISTS public.intercompany_messages_target_uq;
CREATE UNIQUE INDEX intercompany_links_doc_a_active
  ON intercompany_document_links (company_a_id, doc_a_type, doc_a_id) WHERE status = 'active';
CREATE UNIQUE INDEX intercompany_links_doc_b_active
  ON intercompany_document_links (company_b_id, doc_b_type, doc_b_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_links_message_uq
  ON intercompany_document_links (message_id) WHERE message_id IS NOT NULL AND status <> 'unlinked';

-- A document of the receiver is the target of ONE accepted message per receiving company (two accepted messages naming it would
-- leave one that can never link). The guard refuses with a message; the index holds when a writer's guard cannot see the
-- other's uncommitted accept.
CREATE UNIQUE INDEX intercompany_messages_target_uq
  ON intercompany_messages (to_company_id, target_doc_type, target_doc_id)
  WHERE status = 'accepted' AND target_doc_id IS NOT NULL;

-- ── 2. Helpers (new and replaced) ──────────────────────────────────────────────────────────────

-- Internal: do the two companies share a CURRENT membership of one ACTIVE group (company_groups.is_active, which
-- deleteGroup clears)? No access check: only the definer functions below call it, as migration_admin; no app role may execute it.
CREATE OR REPLACE FUNCTION public.intercompany_shared_group(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b AND EXISTS (
    SELECT 1
      FROM public.company_group_members a
      JOIN public.company_group_members b ON b.group_id = a.group_id
      JOIN public.company_groups g ON g.id = a.group_id
     WHERE a.company_id = p_a AND b.company_id = p_b
       AND a.left_date IS NULL AND b.left_date IS NULL
       AND g.is_active IS NOT FALSE)
$$;
REVOKE ALL ON FUNCTION public.intercompany_shared_group(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_shared_group(uuid, uuid) TO migration_admin;

-- True when both companies are in one current, active group, whatever the caller's RLS shows of company_group_members,
-- AND the caller is a party: a user of p_a or p_b (auth.user_companies()). For anyone else (including a session that merely
-- sets app.current_company_id) it is false, so it cannot be used to ask whether two other companies are grouped.
-- The answer is read under the topology row lock, FOR SHARE, held to the end of the transaction (the lock protocol in the
-- header): a membership change or group deletion waits for the transaction that is creating, re-activating or messaging on the
-- strength of the answer, and then revokes what it made; one that comes first has committed by the time the lock is granted, so
-- the read below (a new snapshot after the lock: the function is VOLATILE) sees it. SECURITY DEFINER, owned by migration_admin.
CREATE OR REPLACE FUNCTION public.intercompany_in_one_group(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN
    RETURN false;
  END IF;
  -- A party is a signed-in USER of one of the two companies. The session's active company (a GUC any session can set) proves
  -- nothing and is not consulted; auth.user_companies() is what the RLS policies trust.
  IF NOT (p_a IN (SELECT auth.user_companies()) OR p_b IN (SELECT auth.user_companies())) THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.intercompany_topology_lock FOR SHARE;
  RETURN public.intercompany_shared_group(p_a, p_b);
END;
$$;
ALTER FUNCTION public.intercompany_in_one_group(uuid, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_in_one_group(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_in_one_group(uuid, uuid) TO app_user, app_service;

-- True when the session user holds a write role (owner / admin / manager: DEFAULT_WRITE_ROLES) in the company. SECURITY
-- INVOKER: a user reads their own membership rows (cu_select), which is all this needs. Every app_user write on the five
-- tables below needs it for the company it acts as: a viewer reads only.
CREATE OR REPLACE FUNCTION public.intercompany_user_can_write(p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.company_users cu
     WHERE cu.company_id = p_company AND cu.user_id = auth.uid()
       AND cu.role = ANY (ARRAY['owner', 'admin', 'manager']))
$$;
REVOKE ALL ON FUNCTION public.intercompany_user_can_write(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_user_can_write(uuid) TO app_user, app_service, migration_admin;

-- Does the document exist in the company? Under the caller's RLS: only the session company's own documents are visible.
CREATE OR REPLACE FUNCTION public.intercompany_document_exists(p_type text, p_id uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_type
    WHEN 'customer_invoice' THEN EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_id AND company_id = p_company)
    WHEN 'supplier_invoice' THEN EXISTS (SELECT 1 FROM public.supplier_invoices WHERE id = p_id AND company_id = p_company)
    WHEN 'credit_note' THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_id AND company_id = p_company)
    ELSE false
  END
$$;
REVOKE ALL ON FUNCTION public.intercompany_document_exists(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_document_exists(text, uuid, uuid) TO app_user, app_service;

-- The same question for a company the session is not acting as (a user with a write role in BOTH companies of a group
-- confirms both sides of a pairing from one session, and RLS hides the other company's documents). SECURITY DEFINER, and
-- it answers only for a company in which the session user holds a write role: for any other caller it is false, so it is no
-- way to ask whether a document id exists in someone else's books.
CREATE OR REPLACE FUNCTION public.intercompany_document_exists_as_writer(p_type text, p_id uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.intercompany_user_can_write(p_company) AND CASE p_type
    WHEN 'customer_invoice' THEN EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_id AND company_id = p_company)
    WHEN 'supplier_invoice' THEN EXISTS (SELECT 1 FROM public.supplier_invoices WHERE id = p_id AND company_id = p_company)
    WHEN 'credit_note' THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_id AND company_id = p_company)
    ELSE false
  END
$$;
ALTER FUNCTION public.intercompany_document_exists_as_writer(text, uuid, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_document_exists_as_writer(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_document_exists_as_writer(text, uuid, uuid) TO app_user, app_service;

-- Is the document one a message of `p_kind` carries, in the company? `p_role` is 'source' (the sender's document) or 'target'
-- (the one the receiver created for it). An invoice or interest invoice goes from a customer invoice to a supplier invoice; a
-- credit note from a customer credit note to a supplier credit note. Any other kind carries no document: false. Under the
-- caller's RLS: only the session company's own documents are visible (the company is also matched, so another of the session
-- user's companies is refused too). Never NULL.
CREATE OR REPLACE FUNCTION public.intercompany_message_doc_exists(p_kind text, p_role text, p_type text, p_id uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(CASE
    WHEN p_kind IN ('invoice', 'interest_invoice') AND p_role = 'source' THEN p_type = 'customer_invoice'
      AND EXISTS (SELECT 1 FROM public.customer_invoices WHERE id = p_id AND company_id = p_company)
    WHEN p_kind IN ('invoice', 'interest_invoice') AND p_role = 'target' THEN p_type = 'supplier_invoice'
      AND EXISTS (SELECT 1 FROM public.supplier_invoices WHERE id = p_id AND company_id = p_company)
    WHEN p_kind = 'credit_note' AND p_role = 'source' THEN p_type = 'credit_note'
      AND EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_id AND company_id = p_company AND type = 'customer')
    WHEN p_kind = 'credit_note' AND p_role = 'target' THEN p_type = 'credit_note'
      AND EXISTS (SELECT 1 FROM public.credit_notes WHERE id = p_id AND company_id = p_company AND type = 'supplier')
    ELSE false
  END, false)
$$;
REVOKE ALL ON FUNCTION public.intercompany_message_doc_exists(text, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_message_doc_exists(text, text, text, uuid, uuid) TO app_user, app_service, migration_admin;

-- Does the accepted message's source document exist in the sender's company and its target in the receiver's, each of the type
-- its kind needs? The receiver's session cannot see the sender's documents, so this is a definer. It answers only for the
-- receiver's own session company (a mirror link is made by the receiver); for any other caller it is false, so it is no way to
-- ask whether a document id exists in someone else's books. Calls the invoker check above as migration_admin (BYPASSRLS).
CREATE OR REPLACE FUNCTION public.intercompany_message_documents_ok(p_message uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT public.intercompany_message_doc_exists(m.kind, 'source', m.source_doc_type, m.source_doc_id, m.from_company_id)
       AND public.intercompany_message_doc_exists(m.kind, 'target', m.target_doc_type, m.target_doc_id, m.to_company_id)
      FROM public.intercompany_messages m
     WHERE m.id = p_message AND m.to_company_id = app.current_company_id()), false)
$$;
ALTER FUNCTION public.intercompany_message_documents_ok(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_message_documents_ok(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_message_documents_ok(uuid) TO app_user, app_service;

-- ── 3. Connections guard ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_connections_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  me uuid := app.current_company_id();
  -- The group-membership trigger revokes as migration_admin and says so with a transaction-local flag. The flag alone
  -- proves nothing (any session can set it); migration_admin is a role no app pool is, so both together do.
  system boolean := current_user = 'migration_admin'
                    AND pg_catalog.current_setting('app.intercompany_system_revoke', true) = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind <> 'group' THEN
      RAISE EXCEPTION 'external connections are not available yet' USING ERRCODE = '0A000';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a group connection is created active' USING ERRCODE = '23514';
    END IF;
    IF NOT public.intercompany_in_one_group(NEW.company_low_id, NEW.company_high_id) THEN
      RAISE EXCEPTION 'a group connection needs both companies to be current members of one group' USING ERRCODE = '23514';
    END IF;
    IF NOT (public.intercompany_user_can_write(NEW.company_low_id) AND public.intercompany_user_can_write(NEW.company_high_id)) THEN
      RAISE EXCEPTION 'a group connection needs a write role in both companies' USING ERRCODE = '42501';
    END IF;
    NEW.invited_by := auth.uid();
    NEW.accepted_by := auth.uid();
    NEW.accepted_at := clock_timestamp();
    NEW.revoked_by := NULL;
    NEW.revoked_at := NULL;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_low_id IS DISTINCT FROM OLD.company_low_id
     OR NEW.company_high_id IS DISTINCT FROM OLD.company_high_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.invited_by_company_id IS DISTINCT FROM OLD.invited_by_company_id OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a connection changes only its status and its settings' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  NEW.accepted_by := OLD.accepted_by;
  NEW.accepted_at := OLD.accepted_at;
  NEW.revoked_by := OLD.revoked_by;
  NEW.revoked_at := OLD.revoked_at;

  -- The pair settings: a group connection's change only by a user who can write in BOTH companies, and not once revoked.
  IF NEW.settlement_mode IS DISTINCT FROM OLD.settlement_mode OR NEW.cutover_date IS DISTINCT FROM OLD.cutover_date
     OR NEW.interest_rate_pct IS DISTINCT FROM OLD.interest_rate_pct THEN
    IF NEW.status = 'revoked' OR OLD.status = 'revoked' THEN
      RAISE EXCEPTION 'a revoked connection''s settings cannot change' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind <> 'group' THEN
      RAISE EXCEPTION 'the settings of an external connection are agreed in its invitation' USING ERRCODE = '23514';
    END IF;
    IF NOT (public.intercompany_user_can_write(NEW.company_low_id) AND public.intercompany_user_can_write(NEW.company_high_id)) THEN
      RAISE EXCEPTION 'changing a group connection''s settings needs a write role in both companies' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF system THEN
    IF NEW.status = OLD.status THEN
      RETURN NEW;                         -- the backfill's no-op UPDATE (it only fires the release trigger)
    END IF;
    IF NEW.status <> 'revoked' THEN
      RAISE EXCEPTION 'the group-membership revocation only revokes' USING ERRCODE = '23514';
    END IF;
    NEW.revoked_by := 'system:group-membership';
    NEW.revoked_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- Every other status change comes from a signed-in user acting as one of the two companies, with a write role in it.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'a connection changes status through a signed-in user' USING ERRCODE = '42501';
  END IF;
  IF me IS NULL OR me NOT IN (OLD.company_low_id, OLD.company_high_id) THEN
    RAISE EXCEPTION 'only a party to a connection changes its status' USING ERRCODE = '42501';
  END IF;
  IF NOT public.intercompany_user_can_write(me) THEN
    RAISE EXCEPTION 'changing a connection''s status needs a write role in the company' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;                           -- settings only (checked above); a no-op too, by a user who may write
  END IF;
  IF NEW.status = 'revoked' THEN
    NEW.revoked_by := auth.uid();
    NEW.revoked_at := clock_timestamp();
  ELSIF OLD.status = 'pending' AND NEW.status = 'active' THEN
    IF me = OLD.invited_by_company_id THEN
      RAISE EXCEPTION 'an invitation is accepted by the other company' USING ERRCODE = '42501';
    END IF;
    NEW.accepted_by := auth.uid();
    NEW.accepted_at := clock_timestamp();
  ELSIF OLD.status = 'revoked' AND NEW.status = 'active' THEN
    IF OLD.kind <> 'group' THEN
      RAISE EXCEPTION 'a revoked external connection is invited again, not re-activated' USING ERRCODE = '23514';
    END IF;
    IF NOT public.intercompany_in_one_group(OLD.company_low_id, OLD.company_high_id) THEN
      RAISE EXCEPTION 'a group connection needs both companies to be current members of one group' USING ERRCODE = '23514';
    END IF;
    IF NOT (public.intercompany_user_can_write(OLD.company_low_id) AND public.intercompany_user_can_write(OLD.company_high_id)) THEN
      RAISE EXCEPTION 're-activating a group connection needs a write role in both companies' USING ERRCODE = '42501';
    END IF;
    NEW.accepted_by := auth.uid();
    NEW.accepted_at := clock_timestamp();
    NEW.revoked_by := NULL;
    NEW.revoked_at := NULL;
  ELSE
    RAISE EXCEPTION 'a connection cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_connections_guard ON intercompany_connections;
CREATE TRIGGER trg_intercompany_connections_guard BEFORE INSERT OR UPDATE ON intercompany_connections
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_connections_guard();
ALTER TABLE intercompany_connections ENABLE ALWAYS TRIGGER trg_intercompany_connections_guard;

-- A company that leaves a group (left_date set, the membership moved or deleted), or a group that is deleted
-- (company_groups.is_active cleared, or the row removed), takes its group connections down with it unless the two companies
-- still share another current, active group. SECURITY DEFINER: the user cannot see, or update, the partner's rows. The status
-- change passes the connections guard as the system path (migration_admin plus a transaction-local flag).
CREATE OR REPLACE FUNCTION public.intercompany_group_membership_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  affected uuid[];
BEGIN
  -- The lock protocol (header): (1) row locks first (connections, then their sides), (2) the topology row FOR UPDATE, (3) re-read
  -- and revoke.
  IF TG_TABLE_NAME = 'company_groups' THEN
    SELECT COALESCE(array_agg(m.company_id), '{}') INTO affected FROM public.company_group_members m WHERE m.group_id = OLD.id;
  ELSE
    affected := ARRAY[OLD.company_id];
  END IF;
  PERFORM 1 FROM public.intercompany_connections c
   WHERE c.kind = 'group' AND c.status <> 'revoked'
     AND (c.company_low_id = ANY (affected) OR c.company_high_id = ANY (affected))
   ORDER BY c.id
     FOR NO KEY UPDATE OF c;
  PERFORM 1 FROM public.intercompany_connection_sides s
   WHERE s.connection_id IN (SELECT c.id FROM public.intercompany_connections c
                              WHERE c.kind = 'group' AND c.status <> 'revoked'
                                AND (c.company_low_id = ANY (affected) OR c.company_high_id = ANY (affected)))
   ORDER BY s.connection_id, s.company_id
     FOR NO KEY UPDATE OF s;
  PERFORM 1 FROM public.intercompany_topology_lock FOR UPDATE;
  -- A new snapshot from here on: the writers that held the lock have committed, and so have the leaves that came first.
  IF TG_TABLE_NAME = 'company_groups' THEN
    SELECT COALESCE(array_agg(m.company_id), '{}') INTO affected FROM public.company_group_members m WHERE m.group_id = OLD.id;
  END IF;
  PERFORM pg_catalog.set_config('app.intercompany_system_revoke', 'on', true);
  UPDATE public.intercompany_connections c
     SET status = 'revoked'
   WHERE c.kind = 'group' AND c.status <> 'revoked'
     AND (c.company_low_id = ANY (affected) OR c.company_high_id = ANY (affected))
     AND NOT public.intercompany_shared_group(c.company_low_id, c.company_high_id);
  PERFORM pg_catalog.set_config('app.intercompany_system_revoke', '', true);
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.intercompany_group_membership_changed() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_group_membership_changed() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_intercompany_group_membership ON company_group_members;
CREATE TRIGGER trg_intercompany_group_membership AFTER UPDATE OF left_date, company_id, group_id OR DELETE ON company_group_members
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_group_membership_changed();
ALTER TABLE company_group_members ENABLE ALWAYS TRIGGER trg_intercompany_group_membership;
DROP TRIGGER IF EXISTS trg_intercompany_group_deactivated ON company_groups;
CREATE TRIGGER trg_intercompany_group_deactivated AFTER UPDATE OF is_active OR DELETE ON company_groups
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_group_membership_changed();
ALTER TABLE company_groups ENABLE ALWAYS TRIGGER trg_intercompany_group_deactivated;

-- ── 4. Sides guard ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_sides_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
BEGIN
  -- A first save (INSERT) holds the connection FOR SHARE: a revoke in flight (which locks the connection, then releases the sides
  -- it can SEE, not this uncommitted one) is waited for and seen, and a revoke that comes after waits for this save and releases
  -- it. An UPDATE already holds its side row, which the release trigger needs, so it needs no more.
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id FOR SHARE;
  ELSE
    SELECT * INTO conn FROM intercompany_connections WHERE id = OLD.connection_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
                           OR NEW.partner_company_id IS DISTINCT FROM OLD.partner_company_id) THEN
    RAISE EXCEPTION 'a side keeps its connection and its company' USING ERRCODE = '23514';
  END IF;
  -- A referenced customer, supplier, account, centre or unit that is hard-deleted (a purge, a migration rollback) is nulled
  -- here by its foreign key's SET NULL action, which runs as a trigger of the referenced table (depth 2), and a revoked
  -- connection's release trigger (intercompany_release_links) sets references to NULL and auto_accept off the same way. That
  -- must pass whatever the connection's state: the only changes are a reference going to NULL and auto_accept going true to false.
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2
     AND (NEW.auto_accept = OLD.auto_accept OR (OLD.auto_accept AND NOT NEW.auto_accept))
     AND (NEW.customer_id IS NULL OR NEW.customer_id = OLD.customer_id)
     AND (NEW.supplier_id IS NULL OR NEW.supplier_id = OLD.supplier_id)
     AND (NEW.loan_account_id IS NULL OR NEW.loan_account_id = OLD.loan_account_id)
     AND (NEW.default_expense_account_id IS NULL OR NEW.default_expense_account_id = OLD.default_expense_account_id)
     AND (NEW.default_cc1_id IS NULL OR NEW.default_cc1_id = OLD.default_cc1_id)
     AND (NEW.default_cc2_id IS NULL OR NEW.default_cc2_id = OLD.default_cc2_id)
     AND (NEW.default_bu_id IS NULL OR NEW.default_bu_id = OLD.default_bu_id) THEN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF conn.status = 'revoked' THEN
    RAISE EXCEPTION 'a revoked connection''s sides cannot change' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW.company_id = conn.company_low_id AND NEW.partner_company_id = conn.company_high_id)
       OR (NEW.company_id = conn.company_high_id AND NEW.partner_company_id = conn.company_low_id)) THEN
    RAISE EXCEPTION 'a side belongs to one of the connection''s two companies, facing the other' USING ERRCODE = '23514';
  END IF;
  IF NOT public.intercompany_user_can_write(NEW.company_id) THEN
    RAISE EXCEPTION 'a side is changed by a user with a write role in its company' USING ERRCODE = '42501';
  END IF;
  IF NEW.auto_accept THEN
    IF conn.kind <> 'group' THEN
      RAISE EXCEPTION 'auto-accept is only for a group connection' USING ERRCODE = '23514';
    END IF;
    IF NOT public.intercompany_in_one_group(conn.company_low_id, conn.company_high_id) THEN
      RAISE EXCEPTION 'auto-accept needs both companies to be current members of one group' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM customers WHERE id = NEW.customer_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'the customer is not this company''s' USING ERRCODE = '23503';
  END IF;
  IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM suppliers WHERE id = NEW.supplier_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'the supplier is not this company''s' USING ERRCODE = '23503';
  END IF;
  IF NEW.loan_account_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM gl_accounts WHERE id = NEW.loan_account_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'the loan account is not this company''s' USING ERRCODE = '23503';
  END IF;
  IF NEW.default_expense_account_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM gl_accounts WHERE id = NEW.default_expense_account_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'the default expense account is not this company''s' USING ERRCODE = '23503';
  END IF;
  IF (NEW.default_cc1_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM cost_centres WHERE id = NEW.default_cc1_id AND company_id = NEW.company_id))
     OR (NEW.default_cc2_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM cost_centres WHERE id = NEW.default_cc2_id AND company_id = NEW.company_id))
     OR (NEW.default_bu_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM business_units WHERE id = NEW.default_bu_id AND company_id = NEW.company_id)) THEN
    RAISE EXCEPTION 'a default dimension is not this company''s' USING ERRCODE = '23503';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_sides_guard ON intercompany_connection_sides;
CREATE TRIGGER trg_intercompany_sides_guard BEFORE INSERT OR UPDATE ON intercompany_connection_sides
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_sides_guard();
ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER trg_intercompany_sides_guard;

-- ── 5. Messages guard ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
    END IF;
    IF conn.status <> 'active' THEN
      RAISE EXCEPTION 'a message is sent only on an active connection' USING ERRCODE = '23514';
    END IF;
    IF NOT ((NEW.from_company_id = conn.company_low_id AND NEW.to_company_id = conn.company_high_id)
         OR (NEW.from_company_id = conn.company_high_id AND NEW.to_company_id = conn.company_low_id)) THEN
      RAISE EXCEPTION 'a message goes between the connection''s two companies' USING ERRCODE = '23514';
    END IF;
    IF conn.kind = 'group' AND NOT public.intercompany_in_one_group(conn.company_low_id, conn.company_high_id) THEN
      RAISE EXCEPTION 'a group message needs both companies to be current members of one group' USING ERRCODE = '23514';
    END IF;
    IF NOT public.intercompany_user_can_write(NEW.from_company_id) THEN
      RAISE EXCEPTION 'a message is sent by a user with a write role in the sending company' USING ERRCODE = '42501';
    END IF;
    -- A message that carries a document names one of the SENDER's (the session company), of the type its kind needs: nobody
    -- can send, and the receiver then mirror-link, another company's invoice.
    IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice')
       AND NOT public.intercompany_message_doc_exists(NEW.kind, 'source', NEW.source_doc_type, NEW.source_doc_id, NEW.from_company_id) THEN
      RAISE EXCEPTION 'a document message names a source document of the sending company that fits its kind' USING ERRCODE = '23514';
    END IF;
    NEW.status := 'pending';
    NEW.target_doc_type := NULL;
    NEW.target_doc_id := NULL;
    NEW.reason := NULL;
    NEW.error := NULL;
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
    NEW.handled_via := NULL;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.from_company_id IS DISTINCT FROM OLD.from_company_id OR NEW.to_company_id IS DISTINCT FROM OLD.to_company_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.source_doc_type IS DISTINCT FROM OLD.source_doc_type
     OR NEW.source_doc_id IS DISTINCT FROM OLD.source_doc_id OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a message changes only its handling' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'a handled message is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'dismissed' AND NEW.status <> 'pending' AND NEW.status <> 'dismissed' THEN
    RAISE EXCEPTION 'a dismissed message can only be restored' USING ERRCODE = '23514';
  END IF;
  -- Accepting, rejecting and restoring act on a live relationship; a dismissal does not need one.
  -- (FOR SHARE: a revocation that comes at the same moment waits for this transaction, instead of revoking under it.)
  IF (NEW.status IN ('accepted', 'rejected') OR (OLD.status = 'dismissed' AND NEW.status = 'pending'))
     AND NOT EXISTS (SELECT 1 FROM intercompany_connections WHERE id = OLD.connection_id AND status = 'active' FOR SHARE) THEN
    RAISE EXCEPTION 'a message is accepted, rejected or restored only on an active connection' USING ERRCODE = '23514';
  END IF;
  IF NOT public.intercompany_user_can_write(OLD.to_company_id) THEN
    RAISE EXCEPTION 'a message is handled by a user with a write role in the receiving company' USING ERRCODE = '42501';
  END IF;
  -- A message that creates a document is accepted with that document: it exists in the receiver's company and is of the type
  -- its kind needs. Any target a handler sets (accepting or not) is held to the same rule. (The check is false for a NULL type
  -- or id, so a missing target is refused too.) A kind that creates no document carries no target: whatever was sent is cleared.
  IF NEW.kind IN ('invoice', 'credit_note', 'interest_invoice') THEN
    IF (NEW.status = 'accepted' OR NEW.target_doc_type IS DISTINCT FROM OLD.target_doc_type OR NEW.target_doc_id IS DISTINCT FROM OLD.target_doc_id)
       AND NOT public.intercompany_message_doc_exists(NEW.kind, 'target', NEW.target_doc_type, NEW.target_doc_id, OLD.to_company_id) THEN
      RAISE EXCEPTION 'a message targets a document of the receiving company that fits its kind, and an accepted one names it' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'accepted' AND EXISTS (
         SELECT 1 FROM intercompany_messages m
          WHERE m.to_company_id = OLD.to_company_id AND m.id <> OLD.id AND m.status = 'accepted'
            AND m.target_doc_type = NEW.target_doc_type AND m.target_doc_id = NEW.target_doc_id) THEN
      RAISE EXCEPTION 'a document is the target of one accepted message per receiving company' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.target_doc_type := NULL;
    NEW.target_doc_id := NULL;
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'pending' THEN
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
    NEW.handled_via := NULL;
  ELSE
    NEW.handled_by := auth.uid();
    NEW.handled_at := clock_timestamp();
    -- 'auto' only for a receiver whose side has auto-accept on an active group connection; anything else is a person's act.
    NEW.handled_via := CASE WHEN pg_catalog.current_setting('app.intercompany_handled_via', true) = 'auto'
        AND EXISTS (SELECT 1 FROM intercompany_connection_sides s JOIN intercompany_connections c ON c.id = s.connection_id
                     WHERE s.connection_id = OLD.connection_id AND s.company_id = OLD.to_company_id AND s.auto_accept
                       AND c.kind = 'group' AND c.status = 'active')
      THEN 'auto' ELSE 'user' END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_messages_guard ON intercompany_messages;
CREATE TRIGGER trg_intercompany_messages_guard BEFORE INSERT OR UPDATE ON intercompany_messages
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_messages_guard();
ALTER TABLE intercompany_messages ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard;

-- ── 6. Links guard ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
  msg intercompany_messages%ROWTYPE;
  me uuid := app.current_company_id();
  uid text := auth.uid();
  src_is_a boolean;
BEGIN
  -- A link insert holds its connection FOR SHARE (as accepting a message does): a revoke in flight is waited for and seen.
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id FOR SHARE;
  ELSE
    SELECT * INTO conn FROM intercompany_connections WHERE id = OLD.connection_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF conn.status <> 'active' THEN
      RAISE EXCEPTION 'documents are linked only on an active connection' USING ERRCODE = '23514';
    END IF;
    IF NEW.company_a_id <> conn.company_low_id OR NEW.company_b_id <> conn.company_high_id THEN
      RAISE EXCEPTION 'a link names the connection''s low company as A and its high company as B' USING ERRCODE = '23514';
    END IF;
    IF me IS NULL OR me NOT IN (conn.company_low_id, conn.company_high_id) THEN
      RAISE EXCEPTION 'a link is made from a session of one of its two companies' USING ERRCODE = '42501';
    END IF;
    IF uid IS NULL THEN
      RAISE EXCEPTION 'linking needs a signed-in user' USING ERRCODE = '42501';
    END IF;
    IF NOT public.intercompany_user_can_write(me) THEN
      RAISE EXCEPTION 'linking needs a write role in the company' USING ERRCODE = '42501';
    END IF;

    IF NEW.origin = 'mirror' THEN
      IF NEW.message_id IS NULL THEN
        RAISE EXCEPTION 'a mirror link names its message' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO msg FROM intercompany_messages WHERE id = NEW.message_id AND connection_id = NEW.connection_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'no such message on this connection' USING ERRCODE = '23503';
      END IF;
      IF msg.to_company_id <> me THEN
        RAISE EXCEPTION 'a mirror link is made by the receiver of its message' USING ERRCODE = '42501';
      END IF;
      IF msg.status <> 'accepted' THEN
        RAISE EXCEPTION 'a mirror link needs an accepted message' USING ERRCODE = '23514';
      END IF;
      IF msg.kind NOT IN ('invoice', 'credit_note', 'interest_invoice') THEN
        RAISE EXCEPTION 'a mirror link needs a message that creates a document' USING ERRCODE = '23514';
      END IF;
      src_is_a := msg.from_company_id = conn.company_low_id;
      IF NOT (CASE WHEN src_is_a
                THEN NEW.doc_a_type IS NOT DISTINCT FROM msg.source_doc_type AND NEW.doc_a_id IS NOT DISTINCT FROM msg.source_doc_id
                 AND NEW.doc_b_type IS NOT DISTINCT FROM msg.target_doc_type AND NEW.doc_b_id IS NOT DISTINCT FROM msg.target_doc_id
                ELSE NEW.doc_b_type IS NOT DISTINCT FROM msg.source_doc_type AND NEW.doc_b_id IS NOT DISTINCT FROM msg.source_doc_id
                 AND NEW.doc_a_type IS NOT DISTINCT FROM msg.target_doc_type AND NEW.doc_a_id IS NOT DISTINCT FROM msg.target_doc_id END) THEN
        RAISE EXCEPTION 'a mirror link joins the message''s source and target documents' USING ERRCODE = '23514';
      END IF;
      -- Both documents belong to the message's two companies and fit its kind, whatever the message row holds.
      IF NOT public.intercompany_message_documents_ok(msg.id) THEN
        RAISE EXCEPTION 'a mirror link joins the message''s source and target documents' USING ERRCODE = '23514';
      END IF;
      NEW.status := 'active';
      NEW.confirmed_by_a := uid;
      NEW.confirmed_by_b := uid;
      NEW.confirmed_at := clock_timestamp();
    ELSE
      IF NEW.message_id IS NOT NULL THEN
        RAISE EXCEPTION 'a manual pairing names no message' USING ERRCODE = '23514';
      END IF;
      IF me = conn.company_low_id THEN
        IF NOT public.intercompany_document_exists(NEW.doc_a_type, NEW.doc_a_id, me) THEN
          RAISE EXCEPTION 'the document is not this company''s' USING ERRCODE = '23514';
        END IF;
        NEW.confirmed_by_a := uid;
        NEW.confirmed_by_b := NULL;
      ELSE
        IF NOT public.intercompany_document_exists(NEW.doc_b_type, NEW.doc_b_id, me) THEN
          RAISE EXCEPTION 'the document is not this company''s' USING ERRCODE = '23514';
        END IF;
        NEW.confirmed_by_a := NULL;
        NEW.confirmed_by_b := uid;
      END IF;
      NEW.status := 'pending_confirmation';
      NEW.confirmed_at := NULL;
    END IF;
    NEW.unlinked_at := NULL;
    NEW.unlinked_by := NULL;
    NEW.created_by := uid;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- UPDATE: confirm a side, or unlink.
  IF OLD.status = 'unlinked' THEN
    RAISE EXCEPTION 'an unlinked link is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.company_a_id IS DISTINCT FROM OLD.company_a_id OR NEW.company_b_id IS DISTINCT FROM OLD.company_b_id
     OR NEW.doc_a_type IS DISTINCT FROM OLD.doc_a_type OR NEW.doc_a_id IS DISTINCT FROM OLD.doc_a_id
     OR NEW.doc_b_type IS DISTINCT FROM OLD.doc_b_type OR NEW.doc_b_id IS DISTINCT FROM OLD.doc_b_id
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a link changes only its confirmation and its status' USING ERRCODE = '23514';
  END IF;
  -- The stamps are server-side: whatever was sent is put back.
  NEW.confirmed_at := OLD.confirmed_at;
  NEW.unlinked_at := OLD.unlinked_at;
  NEW.unlinked_by := OLD.unlinked_by;
  IF me IS NULL OR me NOT IN (OLD.company_a_id, OLD.company_b_id) THEN
    RAISE EXCEPTION 'a link is made from a session of one of its two companies' USING ERRCODE = '42501';
  END IF;
  IF uid IS NULL THEN
    RAISE EXCEPTION 'linking needs a signed-in user' USING ERRCODE = '42501';
  END IF;
  IF NOT public.intercompany_user_can_write(me) THEN
    RAISE EXCEPTION 'linking needs a write role in the company' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'unlinked' THEN
    IF NEW.confirmed_by_a IS DISTINCT FROM OLD.confirmed_by_a OR NEW.confirmed_by_b IS DISTINCT FROM OLD.confirmed_by_b THEN
      RAISE EXCEPTION 'unlinking changes nothing else' USING ERRCODE = '23514';
    END IF;
    NEW.unlinked_at := clock_timestamp();
    NEW.unlinked_by := uid;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a link is activated by confirmation' USING ERRCODE = '23514';
  END IF;
  IF (NEW.confirmed_by_a IS DISTINCT FROM OLD.confirmed_by_a OR NEW.confirmed_by_b IS DISTINCT FROM OLD.confirmed_by_b)
     AND conn.status <> 'active' THEN
    RAISE EXCEPTION 'a link is confirmed only on an active connection' USING ERRCODE = '23514';
  END IF;

  IF NEW.confirmed_by_a IS DISTINCT FROM OLD.confirmed_by_a THEN
    IF OLD.confirmed_by_a IS NOT NULL THEN
      RAISE EXCEPTION 'a link is already confirmed on that side' USING ERRCODE = '23514';
    END IF;
    IF NOT ((me = OLD.company_a_id AND public.intercompany_user_can_write(OLD.company_a_id))
         OR (conn.kind = 'group' AND public.intercompany_user_can_write(OLD.company_a_id) AND public.intercompany_user_can_write(OLD.company_b_id))) THEN
      RAISE EXCEPTION 'confirming needs a write role in the company (or in both, for a group)' USING ERRCODE = '42501';
    END IF;
    IF NOT public.intercompany_document_exists_as_writer(OLD.doc_a_type, OLD.doc_a_id, OLD.company_a_id) THEN
      RAISE EXCEPTION 'the document is not this company''s' USING ERRCODE = '23514';
    END IF;
    NEW.confirmed_by_a := uid;
  END IF;
  IF NEW.confirmed_by_b IS DISTINCT FROM OLD.confirmed_by_b THEN
    IF OLD.confirmed_by_b IS NOT NULL THEN
      RAISE EXCEPTION 'a link is already confirmed on that side' USING ERRCODE = '23514';
    END IF;
    IF NOT ((me = OLD.company_b_id AND public.intercompany_user_can_write(OLD.company_b_id))
         OR (conn.kind = 'group' AND public.intercompany_user_can_write(OLD.company_a_id) AND public.intercompany_user_can_write(OLD.company_b_id))) THEN
      RAISE EXCEPTION 'confirming needs a write role in the company (or in both, for a group)' USING ERRCODE = '42501';
    END IF;
    IF NOT public.intercompany_document_exists_as_writer(OLD.doc_b_type, OLD.doc_b_id, OLD.company_b_id) THEN
      RAISE EXCEPTION 'the document is not this company''s' USING ERRCODE = '23514';
    END IF;
    NEW.confirmed_by_b := uid;
  END IF;
  IF OLD.status = 'pending_confirmation' AND NEW.confirmed_by_a IS NOT NULL AND NEW.confirmed_by_b IS NOT NULL THEN
    NEW.status := 'active';
    NEW.confirmed_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_links_guard ON intercompany_document_links;
CREATE TRIGGER trg_intercompany_links_guard BEFORE INSERT OR UPDATE ON intercompany_document_links
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_links_guard();
ALTER TABLE intercompany_document_links ENABLE ALWAYS TRIGGER trg_intercompany_links_guard;

-- A key is managed by a write role of its own company.
CREATE OR REPLACE FUNCTION public.intercompany_keys_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.intercompany_user_can_write(NEW.company_id) THEN
    RAISE EXCEPTION 'a connection key is managed by a user with a write role in its company' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_keys_guard ON company_connection_keys;
CREATE TRIGGER trg_intercompany_keys_guard BEFORE INSERT OR UPDATE ON company_connection_keys
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_keys_guard();
ALTER TABLE company_connection_keys ENABLE ALWAYS TRIGGER trg_intercompany_keys_guard;


-- ── 7. A revoked connection releases its sides' customer and supplier links ─────────────────

-- SECURITY DEFINER: either party may revoke, and a company cannot see or update its partner's side. The UPDATE it runs is a
-- second trigger level and only sets references to NULL and auto_accept to false, which the sides guard lets through whatever
-- the connection's state. (A re-activated group connection then starts with auto-accept off: the receiver turns it on again.)
CREATE OR REPLACE FUNCTION public.intercompany_release_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.intercompany_connection_sides
     SET customer_id = NULL, supplier_id = NULL, auto_accept = false
   WHERE connection_id = NEW.id AND (customer_id IS NOT NULL OR supplier_id IS NOT NULL OR auto_accept);
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.intercompany_release_links() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_release_links() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_intercompany_release_links ON intercompany_connections;
CREATE TRIGGER trg_intercompany_release_links AFTER UPDATE OF status ON intercompany_connections
  FOR EACH ROW WHEN (NEW.status = 'revoked')
  EXECUTE FUNCTION public.intercompany_release_links();
ALTER TABLE intercompany_connections ENABLE ALWAYS TRIGGER trg_intercompany_release_links;

REVOKE ALL ON FUNCTION public.intercompany_keys_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_connections_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_sides_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_messages_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_links_guard() FROM PUBLIC;

-- ── 8. The definer registry (930) ──────────────────────────────────────────────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_in_one_group(uuid,uuid)', 'public.intercompany_in_one_group(uuid, uuid)',
     'nothing (read of company_group_members, company_groups and company_users: are two companies in one current, active group; false unless the caller is a party; takes the topology row FOR SHARE (intercompany_topology_lock) for a party, held until the transaction ends)'),
    ('intercompany_message_documents_ok(uuid)', 'public.intercompany_message_documents_ok(uuid)',
     'nothing (read of intercompany_messages, customer_invoices, supplier_invoices, credit_notes: do an accepted message''s source and target documents exist in its sender and receiver, of the types its kind needs; false unless the session company is the receiver)'),
    ('intercompany_document_exists_as_writer(text,uuid,uuid)', 'public.intercompany_document_exists_as_writer(text, uuid, uuid)',
     'nothing (read of customer_invoices, supplier_invoices, credit_notes: does a document exist in a company in which the session user holds a write role; false otherwise)'),
    ('intercompany_group_membership_changed()', 'public.intercompany_group_membership_changed()',
     'intercompany_connections.status = ''revoked'' (its revoked_by / revoked_at stamps, through the connections guard system path) for a group connection whose companies no longer share a current active group, after FOR NO KEY UPDATE row locks on the candidate connections and their sides and FOR UPDATE on the topology row (intercompany_topology_lock); trigger function on company_group_members and company_groups, no EXECUTE for app roles'),
    ('intercompany_release_links()', 'public.intercompany_release_links()',
     'intercompany_connection_sides.customer_id and supplier_id = NULL and auto_accept = false for the sides of a connection that has just been revoked (through the sides guard''s foreign-key-action path); trigger function on intercompany_connections, no EXECUTE for app roles')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p,
                  unnest(ARRAY['public', 'app_user', 'app_service']) r
              WHERE pg_catalog.has_table_privilege(r, 'public.intercompany_topology_lock', p)) THEN
    RAISE EXCEPTION '1002: an app role can reach intercompany_topology_lock';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_in_one_group(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_message_documents_ok(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_message_doc_exists(text, text, text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_document_exists_as_writer(text, uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_group_membership_changed()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_group_membership_changed()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_release_links()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_release_links()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_shared_group(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1002: a role it must not reach can execute an intercompany function';
  END IF;
END $$;

-- ── 9. Backfill for rows 1000 may already hold ─────────────────────────────────────────────

-- Group connections whose group has gone (deleted, or a company left) are revoked, as the new triggers would have done. The
-- revocation is the connections guard's system path: migration_admin plus the transaction-local flag. The release trigger then
-- frees their links and switches their auto-accept off.
SELECT pg_catalog.set_config('app.intercompany_system_revoke', 'on', true);
SET LOCAL ROLE migration_admin;
UPDATE public.intercompany_connections c SET status = 'revoked'
 WHERE c.kind = 'group' AND c.status <> 'revoked'
   AND NOT public.intercompany_shared_group(c.company_low_id, c.company_high_id);

-- Connections revoked before this migration still hold their links and their auto-accept. A status UPDATE to the value a row
-- already has is, on the system path, a no-op for the guard (it returns the row; only updated_at, which every guarded
-- UPDATE stamps, moves) and fires the release trigger, whose own UPDATE of the sides is a second trigger level, which the sides
-- guard lets through. No trigger is switched off.
UPDATE public.intercompany_connections c SET status = 'revoked'
 WHERE c.status = 'revoked'
   AND EXISTS (SELECT 1 FROM public.intercompany_connection_sides s
                WHERE s.connection_id = c.id AND (s.customer_id IS NOT NULL OR s.supplier_id IS NOT NULL OR s.auto_accept));
RESET ROLE;
SELECT pg_catalog.set_config('app.intercompany_system_revoke', '', true);
