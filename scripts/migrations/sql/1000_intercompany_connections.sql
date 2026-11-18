-- 1000: Intercompany mirror posting, P1 (connections). Plan: docs/plans/2026-11-17-intercompany-mirror-posting.md.
--
-- WHAT. The five tables of the plan's data model. P1's code reads and writes only the first two; the other three
-- are tables, grants, RLS and guards so that P2-P6 add code, not schema.
--   intercompany_connections       one row per ORDERED pair of companies (low < high); at most one LIVE (not revoked)
--                                  row per pair. kind group|external, status pending|active|revoked. The PAIR facts
--                                  live here, not on a side: settlement_mode (cash|loan), cutover_date and
--                                  interest_rate_pct are one agreement between the two companies. P1 creates GROUP
--                                  connections only (created active, both companies current members of one group);
--                                  an external one cannot be created until P6.
--   intercompany_connection_sides  one row per company per connection: that company's OWN settings (customer, supplier,
--                                  loan account, default expense account, dimensions, auto-accept). A company never
--                                  reads its partner's side.
--   company_connection_keys        a company's private connection key, stored as a SHA-256 hex hash (P6).
--   intercompany_messages          the outbox/inbox: the sender inserts, the receiver changes status (P2).
--   intercompany_document_links    the authoritative pair record "A's document X is B's document Y": a MIRROR link
--                                  (made by the receiver of an accepted message) or a MANUAL pairing (pending until
--                                  the other party confirms). P2-P4 read it.
--
-- RULES IN THE DATABASE (each is also checked by the service; the database is the last line).
--   - Tenancy: forced RLS on every table, policies TO app_user. A connection, a message and a link are visible to
--     their two parties only; a side and a key to their own company only. Every policy also requires the session
--     company to be one of the user's companies (the 944 form: <party column> = app.current_company_id() AND
--     <party column> IN (SELECT auth.user_companies())). No table has a DELETE grant for app_user.
--   - Group membership holds for the life of a GROUP connection. intercompany_in_one_group(a, b) (SECURITY DEFINER, so
--     it answers whatever the caller's RLS shows of company_group_members) is checked when a group connection is
--     created or re-activated, when a message is inserted on one, and when a side turns auto_accept on. A trigger on
--     company_group_members (left_date, company, group, DELETE) revokes a company's active group connections
--     that no longer have a shared current group, stamped 'system:group-membership'.
--   - Pair settings (mode, cut-over, interest) of a group connection change only by a user with a write role in BOTH
--     companies, and not once it is revoked. Creating or re-activating a group connection needs the same.
--   - auto_accept only on a group connection; a side's customer, supplier, accounts and dimensions are the company's own;
--     a customer or supplier is linked to one connection per company (partial unique indexes); a revoked connection's
--     sides do not change.
--   - Messages: UNIQUE (from company, source doc type, source doc id, kind); inserted only on an active connection
--     between its two companies; the sender only inserts, the receiver moves a pending message on (a dismissal can be
--     restored; accepted and rejected are final; accepting needs the connection active); handling is stamped server-side
--     (handled_by, handled_at, handled_via 'user'|'auto' from the session setting app.intercompany_handled_via); the
--     payload is at most 256 KiB.
--   - Links: see the guard below. Stamps (invited_by, accepted_by, revoked_by, handled_by, confirmed_by, unlinked_by and
--     their times) are the session user and the clock, set by the triggers whatever was sent.
--
-- DEFINER FUNCTIONS (registered in app_definer_reviews, 930; owner migration_admin; pinned search_path, pg_temp last;
-- EXECUTE for app_user and app_service only): intercompany_in_one_group(uuid, uuid) reads company_group_members;
-- intercompany_group_membership_changed() (trigger function) writes intercompany_connections.status = 'revoked'.
-- Every other function here is SECURITY INVOKER.
--
-- OLD COLOUR: nothing in the previous release reads or writes these tables. The trigger on company_group_members is a
-- no-op for rows nothing references.
-- LOCKS: new objects, plus a trigger on company_group_members (a brief lock, bounded by lock_timeout).
--
-- Rollback (code first):
--   DROP TRIGGER IF EXISTS trg_intercompany_group_membership ON company_group_members;
--   DROP TABLE IF EXISTS intercompany_document_links, intercompany_messages, company_connection_keys,
--     intercompany_connection_sides, intercompany_connections;
--   DROP FUNCTION IF EXISTS public.intercompany_group_membership_changed(), public.intercompany_in_one_group(uuid, uuid),
--     public.intercompany_user_can_write(uuid), public.intercompany_connections_guard(), public.intercompany_sides_guard(),
--     public.intercompany_messages_guard(), public.intercompany_links_guard();
--   DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_in_one_group(uuid,uuid)', 'intercompany_group_membership_changed()');
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intercompany_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_low_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_high_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'external')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  invited_by_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The session user; intercompany_connections_guard overwrites anything sent.
  invited_by VARCHAR(255) NOT NULL DEFAULT auth.uid(),
  accepted_by VARCHAR(255),
  accepted_at TIMESTAMPTZ,
  revoked_by VARCHAR(255),
  revoked_at TIMESTAMPTZ,
  -- The pair's agreement (plan ruling 3, 5, 7): one per connection, not one per side.
  settlement_mode TEXT NOT NULL DEFAULT 'cash' CHECK (settlement_mode IN ('cash', 'loan')),
  cutover_date DATE,
  -- NULL = no interest (the default); P7 reads it.
  interest_rate_pct NUMERIC(7,4) CHECK (interest_rate_pct IS NULL OR (interest_rate_pct >= 0 AND interest_rate_pct <= 100)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_connections_ordered CHECK (company_low_id < company_high_id),
  CONSTRAINT intercompany_connections_inviter CHECK (invited_by_company_id IN (company_low_id, company_high_id)),
  CONSTRAINT intercompany_connections_active_stamp CHECK (status <> 'active' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT intercompany_connections_revoked_stamp CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL))
);
-- One LIVE connection per pair: a revoked row is history and does not stand in the way of a new (or the same, re-activated) one.
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_connections_live_pair_uq
  ON intercompany_connections (company_low_id, company_high_id) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS idx_intercompany_connections_high ON intercompany_connections (company_high_id);

CREATE TABLE IF NOT EXISTS intercompany_connection_sides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES intercompany_connections(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  loan_account_id UUID REFERENCES gl_accounts(id) ON DELETE SET NULL,
  default_expense_account_id UUID REFERENCES gl_accounts(id) ON DELETE SET NULL,
  default_cc1_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL,
  default_cc2_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL,
  default_bu_id UUID REFERENCES business_units(id) ON DELETE SET NULL,
  auto_accept BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_sides_one_per_company UNIQUE (connection_id, company_id),
  CONSTRAINT intercompany_sides_distinct CHECK (company_id <> partner_company_id)
);
-- A customer (supplier) is the partner on one connection of its company: the P2 lookup "who is this sender" is one row.
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_sides_customer_uq
  ON intercompany_connection_sides (company_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_sides_supplier_uq
  ON intercompany_connection_sides (company_id, supplier_id) WHERE supplier_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS company_connection_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intercompany_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES intercompany_connections(id) ON DELETE CASCADE,
  from_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  to_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit_note', 'payment', 'allocation', 'interest_invoice', 'reject', 'credit_request')),
  -- For the allocation and payment kinds, source_doc is the allocation / payment ROW id, so a repeat event is a distinct message.
  source_doc_type TEXT NOT NULL CHECK (char_length(source_doc_type) BETWEEN 1 AND 50),
  source_doc_id UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed', 'failed')),
  target_doc_type TEXT CHECK (target_doc_type IS NULL OR char_length(target_doc_type) BETWEEN 1 AND 50),
  target_doc_id UUID,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 2000),
  -- A generic sentence a person can read; never raw SQL or exception text.
  error TEXT CHECK (error IS NULL OR char_length(error) <= 4000),
  handled_by VARCHAR(255),
  handled_at TIMESTAMPTZ,
  handled_via TEXT CHECK (handled_via IS NULL OR handled_via IN ('user', 'auto')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_messages_distinct CHECK (from_company_id <> to_company_id),
  CONSTRAINT intercompany_messages_once UNIQUE (from_company_id, source_doc_type, source_doc_id, kind),
  CONSTRAINT intercompany_messages_reject_reason CHECK (status <> 'rejected' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT intercompany_messages_payload_size CHECK (octet_length(payload::text) <= 262144)
);
CREATE INDEX IF NOT EXISTS idx_intercompany_messages_inbox ON intercompany_messages (to_company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intercompany_messages_outbox ON intercompany_messages (from_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intercompany_messages_connection ON intercompany_messages (connection_id);

CREATE TABLE IF NOT EXISTS intercompany_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES intercompany_connections(id) ON DELETE CASCADE,
  -- The accepted message a MIRROR link records (NULL for a manual pairing).
  message_id UUID REFERENCES intercompany_messages(id),
  -- company_a is the connection's low company, company_b its high company (the guard enforces it).
  company_a_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_a_type TEXT NOT NULL CHECK (doc_a_type IN ('customer_invoice', 'supplier_invoice', 'credit_note')),
  doc_a_id UUID NOT NULL,
  company_b_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_b_type TEXT NOT NULL CHECK (doc_b_type IN ('customer_invoice', 'supplier_invoice', 'credit_note')),
  doc_b_id UUID NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('mirror', 'manual_pairing')),
  status TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN ('pending_confirmation', 'active', 'unlinked')),
  confirmed_by_a VARCHAR(255),
  confirmed_by_b VARCHAR(255),
  confirmed_at TIMESTAMPTZ,
  unlinked_at TIMESTAMPTZ,
  unlinked_by VARCHAR(255),
  created_by VARCHAR(255) NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A document is in one LIVE link per connection; an unlinked one can be linked again.
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_links_doc_a_live
  ON intercompany_document_links (connection_id, doc_a_type, doc_a_id) WHERE status <> 'unlinked';
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_links_doc_b_live
  ON intercompany_document_links (connection_id, doc_b_type, doc_b_id) WHERE status <> 'unlinked';
CREATE INDEX IF NOT EXISTS idx_intercompany_links_company_b ON intercompany_document_links (company_b_id);
CREATE INDEX IF NOT EXISTS idx_intercompany_links_message ON intercompany_document_links (message_id) WHERE message_id IS NOT NULL;

-- ── 2. Helpers ──────────────────────────────────────────────────────────────

-- True when both companies are CURRENT members (left_date IS NULL) of one group, whatever the caller's RLS shows of
-- company_group_members (a user of one company reads only its own membership row). SECURITY DEFINER, owned by
-- migration_admin (BYPASSRLS), so the answer is the same for every caller.
CREATE OR REPLACE FUNCTION public.intercompany_in_one_group(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b AND EXISTS (
    SELECT 1
      FROM public.company_group_members a
      JOIN public.company_group_members b ON b.group_id = a.group_id
     WHERE a.company_id = p_a AND b.company_id = p_b
       AND a.left_date IS NULL AND b.left_date IS NULL)
$$;
ALTER FUNCTION public.intercompany_in_one_group(uuid, uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_in_one_group(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_in_one_group(uuid, uuid) TO app_user, app_service;

-- True when the session user holds a write role (owner / admin / manager: DEFAULT_WRITE_ROLES) in the company. SECURITY
-- INVOKER: a user reads their own membership rows (cu_select), which is all this needs.
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
GRANT EXECUTE ON FUNCTION public.intercompany_user_can_write(uuid) TO app_user, app_service;

-- ── 3. Connections guard ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.intercompany_connections_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
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

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  -- A status change comes from a signed-in user, or from the group-membership trigger (a second trigger level).
  IF auth.uid() IS NULL AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'a connection changes status through a signed-in user' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'revoked' THEN
    NEW.revoked_by := COALESCE(auth.uid(), 'system:group-membership');
    NEW.revoked_at := clock_timestamp();
  ELSIF OLD.status = 'pending' AND NEW.status = 'active' THEN
    IF app.current_company_id() IS NULL OR app.current_company_id() NOT IN (OLD.company_low_id, OLD.company_high_id) THEN
      RAISE EXCEPTION 'only a party to a connection accepts it' USING ERRCODE = '42501';
    END IF;
    IF app.current_company_id() = OLD.invited_by_company_id THEN
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

-- A company that leaves a group (left_date set, the membership moved or deleted) takes its group connections down with
-- it unless the two still share another current group. SECURITY DEFINER: the leaving user cannot see, or update, the
-- partner's rows. The status change passes the connections guard as a second trigger level (stamp: system).
CREATE OR REPLACE FUNCTION public.intercompany_group_membership_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.intercompany_connections c
     SET status = 'revoked'
   WHERE c.kind = 'group' AND c.status <> 'revoked'
     AND OLD.company_id IN (c.company_low_id, c.company_high_id)
     AND NOT EXISTS (
       SELECT 1
         FROM public.company_group_members a
         JOIN public.company_group_members b ON b.group_id = a.group_id
        WHERE a.company_id = c.company_low_id AND b.company_id = c.company_high_id
          AND a.left_date IS NULL AND b.left_date IS NULL);
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.intercompany_group_membership_changed() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_group_membership_changed() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_intercompany_group_membership ON company_group_members;
CREATE TRIGGER trg_intercompany_group_membership AFTER UPDATE OF left_date, company_id, group_id OR DELETE ON company_group_members
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_group_membership_changed();
ALTER TABLE company_group_members ENABLE ALWAYS TRIGGER trg_intercompany_group_membership;

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
  SELECT * INTO conn FROM intercompany_connections WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.connection_id ELSE OLD.connection_id END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
                           OR NEW.partner_company_id IS DISTINCT FROM OLD.partner_company_id) THEN
    RAISE EXCEPTION 'a side keeps its connection and its company' USING ERRCODE = '23514';
  END IF;
  IF conn.status = 'revoked' THEN
    -- The one change a revoked side takes: a referenced row deleted, where the FK's ON DELETE SET NULL nulls the column
    -- (customers, suppliers, gl_accounts, cost_centres, business_units). Every other column stays as it was and each
    -- reference stays or goes to NULL, and at least one does; anything else (a no-op included) is refused. Without this, deleting a customer (or a purge) would fail.
    IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id AND NEW.auto_accept IS NOT DISTINCT FROM OLD.auto_accept
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
       AND (NEW.customer_id IS NULL OR NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id)
       AND (NEW.supplier_id IS NULL OR NEW.supplier_id IS NOT DISTINCT FROM OLD.supplier_id)
       AND (NEW.loan_account_id IS NULL OR NEW.loan_account_id IS NOT DISTINCT FROM OLD.loan_account_id)
       AND (NEW.default_expense_account_id IS NULL OR NEW.default_expense_account_id IS NOT DISTINCT FROM OLD.default_expense_account_id)
       AND (NEW.default_cc1_id IS NULL OR NEW.default_cc1_id IS NOT DISTINCT FROM OLD.default_cc1_id)
       AND (NEW.default_cc2_id IS NULL OR NEW.default_cc2_id IS NOT DISTINCT FROM OLD.default_cc2_id)
       AND (NEW.default_bu_id IS NULL OR NEW.default_bu_id IS NOT DISTINCT FROM OLD.default_bu_id)
       AND (NEW.customer_id, NEW.supplier_id, NEW.loan_account_id, NEW.default_expense_account_id, NEW.default_cc1_id, NEW.default_cc2_id, NEW.default_bu_id)
           IS DISTINCT FROM
           (OLD.customer_id, OLD.supplier_id, OLD.loan_account_id, OLD.default_expense_account_id, OLD.default_cc1_id, OLD.default_cc2_id, OLD.default_bu_id) THEN
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a revoked connection''s sides cannot change' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW.company_id = conn.company_low_id AND NEW.partner_company_id = conn.company_high_id)
       OR (NEW.company_id = conn.company_high_id AND NEW.partner_company_id = conn.company_low_id)) THEN
    RAISE EXCEPTION 'a side belongs to one of the connection''s two companies, facing the other' USING ERRCODE = '23514';
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
    SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id;
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
  IF NEW.status = 'accepted' THEN
    IF NOT EXISTS (SELECT 1 FROM intercompany_connections WHERE id = OLD.connection_id AND status = 'active') THEN
      RAISE EXCEPTION 'a message is accepted only on an active connection' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'pending' THEN
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
    NEW.handled_via := NULL;
  ELSE
    NEW.handled_by := auth.uid();
    NEW.handled_at := clock_timestamp();
    NEW.handled_via := CASE WHEN pg_catalog.current_setting('app.intercompany_handled_via', true) = 'auto' THEN 'auto' ELSE 'user' END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_messages_guard ON intercompany_messages;
CREATE TRIGGER trg_intercompany_messages_guard BEFORE INSERT OR UPDATE ON intercompany_messages
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_messages_guard();
ALTER TABLE intercompany_messages ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard;

-- ── 6. Links guard ──────────────────────────────────────────────────────────

-- Does the document exist in the company? (under the caller's RLS, so a foreign company's row is not seen either)
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
  SELECT * INTO conn FROM intercompany_connections WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.connection_id ELSE OLD.connection_id END;
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
      src_is_a := msg.from_company_id = conn.company_low_id;
      IF NOT (CASE WHEN src_is_a
                THEN NEW.doc_a_type = msg.source_doc_type AND NEW.doc_a_id = msg.source_doc_id
                 AND NEW.doc_b_type = msg.target_doc_type AND NEW.doc_b_id = msg.target_doc_id
                ELSE NEW.doc_b_type = msg.source_doc_type AND NEW.doc_b_id = msg.source_doc_id
                 AND NEW.doc_a_type = msg.target_doc_type AND NEW.doc_a_id = msg.target_doc_id END) THEN
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

  IF NEW.confirmed_by_a IS DISTINCT FROM OLD.confirmed_by_a THEN
    IF OLD.confirmed_by_a IS NOT NULL THEN
      RAISE EXCEPTION 'a link is already confirmed on that side' USING ERRCODE = '23514';
    END IF;
    IF NOT ((me = OLD.company_a_id AND public.intercompany_user_can_write(OLD.company_a_id))
         OR (conn.kind = 'group' AND public.intercompany_user_can_write(OLD.company_a_id) AND public.intercompany_user_can_write(OLD.company_b_id))) THEN
      RAISE EXCEPTION 'confirming needs a write role in the company (or in both, for a group)' USING ERRCODE = '42501';
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

-- ── 7. Tenancy: 944's form; parties see a shared row, one company sees its own ──

ALTER TABLE intercompany_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS party_read ON intercompany_connections;
CREATE POLICY party_read ON intercompany_connections FOR SELECT TO app_user
  USING (company_low_id = app.current_company_id() AND company_low_id IN (SELECT auth.user_companies())
          OR company_high_id = app.current_company_id() AND company_high_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS party_insert ON intercompany_connections;
CREATE POLICY party_insert ON intercompany_connections FOR INSERT TO app_user
  WITH CHECK (invited_by_company_id = app.current_company_id() AND invited_by_company_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS party_update ON intercompany_connections;
CREATE POLICY party_update ON intercompany_connections FOR UPDATE TO app_user
  USING (company_low_id = app.current_company_id() AND company_low_id IN (SELECT auth.user_companies())
          OR company_high_id = app.current_company_id() AND company_high_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_low_id = app.current_company_id() AND company_low_id IN (SELECT auth.user_companies())
          OR company_high_id = app.current_company_id() AND company_high_id IN (SELECT auth.user_companies()));

ALTER TABLE intercompany_connection_sides ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_connection_sides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON intercompany_connection_sides;
CREATE POLICY tenant_isolation ON intercompany_connection_sides FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

ALTER TABLE company_connection_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_connection_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_connection_keys;
CREATE POLICY tenant_isolation ON company_connection_keys FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

ALTER TABLE intercompany_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS party_read ON intercompany_messages;
CREATE POLICY party_read ON intercompany_messages FOR SELECT TO app_user
  USING (from_company_id = app.current_company_id() AND from_company_id IN (SELECT auth.user_companies())
          OR to_company_id = app.current_company_id() AND to_company_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS sender_insert ON intercompany_messages;
CREATE POLICY sender_insert ON intercompany_messages FOR INSERT TO app_user
  WITH CHECK (from_company_id = app.current_company_id() AND from_company_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS receiver_update ON intercompany_messages;
CREATE POLICY receiver_update ON intercompany_messages FOR UPDATE TO app_user
  USING (to_company_id = app.current_company_id() AND to_company_id IN (SELECT auth.user_companies()))
  WITH CHECK (to_company_id = app.current_company_id() AND to_company_id IN (SELECT auth.user_companies()));

ALTER TABLE intercompany_document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_document_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS party_read ON intercompany_document_links;
CREATE POLICY party_read ON intercompany_document_links FOR SELECT TO app_user
  USING (company_a_id = app.current_company_id() AND company_a_id IN (SELECT auth.user_companies())
          OR company_b_id = app.current_company_id() AND company_b_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS party_insert ON intercompany_document_links;
CREATE POLICY party_insert ON intercompany_document_links FOR INSERT TO app_user
  WITH CHECK (company_a_id = app.current_company_id() AND company_a_id IN (SELECT auth.user_companies())
          OR company_b_id = app.current_company_id() AND company_b_id IN (SELECT auth.user_companies()));
DROP POLICY IF EXISTS party_update ON intercompany_document_links;
CREATE POLICY party_update ON intercompany_document_links FOR UPDATE TO app_user
  USING (company_a_id = app.current_company_id() AND company_a_id IN (SELECT auth.user_companies())
          OR company_b_id = app.current_company_id() AND company_b_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_a_id = app.current_company_id() AND company_a_id IN (SELECT auth.user_companies())
          OR company_b_id = app.current_company_id() AND company_b_id IN (SELECT auth.user_companies()));

-- ── 8. Privileges: 348's default gave app_user every command; take it back, grant per column ──

REVOKE INSERT, UPDATE, DELETE ON intercompany_connections FROM app_user;
GRANT SELECT ON intercompany_connections TO app_user;
GRANT INSERT (company_low_id, company_high_id, kind, status, invited_by_company_id) ON intercompany_connections TO app_user;
GRANT UPDATE (status, settlement_mode, cutover_date, interest_rate_pct) ON intercompany_connections TO app_user;

REVOKE INSERT, UPDATE, DELETE ON intercompany_connection_sides FROM app_user;
GRANT SELECT ON intercompany_connection_sides TO app_user;
GRANT INSERT (connection_id, company_id, partner_company_id, customer_id, supplier_id, loan_account_id,
              default_expense_account_id, default_cc1_id, default_cc2_id, default_bu_id, auto_accept)
  ON intercompany_connection_sides TO app_user;
GRANT UPDATE (customer_id, supplier_id, loan_account_id, default_expense_account_id, default_cc1_id, default_cc2_id,
              default_bu_id, auto_accept) ON intercompany_connection_sides TO app_user;

REVOKE INSERT, UPDATE, DELETE ON company_connection_keys FROM app_user;
GRANT SELECT ON company_connection_keys TO app_user;
GRANT INSERT (company_id, key_hash) ON company_connection_keys TO app_user;
GRANT UPDATE (key_hash, rotated_at) ON company_connection_keys TO app_user;

REVOKE INSERT, UPDATE, DELETE ON intercompany_messages FROM app_user;
GRANT SELECT ON intercompany_messages TO app_user;
GRANT INSERT (connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
  ON intercompany_messages TO app_user;
GRANT UPDATE (status, target_doc_type, target_doc_id, reason, error) ON intercompany_messages TO app_user;

REVOKE INSERT, UPDATE, DELETE ON intercompany_document_links FROM app_user;
GRANT SELECT ON intercompany_document_links TO app_user;
GRANT INSERT (connection_id, message_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin)
  ON intercompany_document_links TO app_user;
-- The confirmation columns carry any non-null value: the trigger replaces it with the session user. status takes 'unlinked' only.
GRANT UPDATE (status, confirmed_by_a, confirmed_by_b) ON intercompany_document_links TO app_user;

REVOKE ALL ON FUNCTION public.intercompany_connections_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_sides_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_messages_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_links_guard() FROM PUBLIC;

-- ── 9. The definer registry (930) ───────────────────────────────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_in_one_group(uuid,uuid)', 'public.intercompany_in_one_group(uuid, uuid)', 'nothing (read of company_group_members: are two companies current members of one group)'),
    ('intercompany_group_membership_changed()', 'public.intercompany_group_membership_changed()',
     'intercompany_connections.status = ''revoked'' (and its revoked_by / revoked_at stamps, through the connections guard) for a group connection whose companies no longer share a current group; trigger function on company_group_members, no EXECUTE for app roles')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_in_one_group(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_group_membership_changed()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('app_user', 'public.intercompany_group_membership_changed()', 'EXECUTE') THEN
    RAISE EXCEPTION '1000: a role it must not reach can execute an intercompany definer function';
  END IF;
END $$;

-- The service pool reaches the tables through the mirrors 915 creates from the app_user policies.
SELECT public.app_service_sync_policies();
