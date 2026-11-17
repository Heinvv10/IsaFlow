-- 999p: Intercompany mirror posting, P1 (connections). Plan: docs/plans/2026-11-17-intercompany-mirror-posting.md.
--
-- WHAT. The five tables of the plan's data model. P1's code reads and writes only the first two; the other
-- three are tables, grants and RLS so that P2-P6 add code, not schema.
--   intercompany_connections       one row per ORDERED pair of companies (low < high, unique): kind group|external,
--                                  status pending|active|revoked. A group connection is created active (both
--                                  companies are current members of one company_groups row); an external one is
--                                  created pending and accepted by the OTHER company (P6).
--   intercompany_connection_sides  one row per company per connection: that company's own settings (customer,
--                                  supplier, settlement mode, loan and expense accounts, dimensions, auto-accept,
--                                  cut-over date, interest rate). A company never reads its partner's side.
--   company_connection_keys        a company's private connection key, stored as a SHA-256 hex hash (P6).
--   intercompany_messages          the outbox/inbox: the sender inserts, the receiver changes status (P2).
--   intercompany_document_links    the pair fact "A's document X is B's document Y" (P2, P3).
--
-- RULES IN THE DATABASE (each is also checked by the service; the database is the last line).
--   - Tenancy: forced RLS on every table, policies TO app_user. A connection, a message and a link are visible
--     to their two parties only; a side and a key to their own company only. Every policy also requires the
--     session company to be one of the user's companies (the 944 form: app.current_company_id() AND
--     auth.user_companies()). No table has a DELETE grant for app_user.
--   - Ordered pair: CHECK (company_low_id < company_high_id) and UNIQUE (company_low_id, company_high_id).
--   - Group: a group connection is created only while both companies are current members (left_date IS NULL) of
--     one group, as the creating user sees them (company_group_members' RLS is by the user's own companies, so a
--     user who belongs to only one of the two cannot create it). Re-activating a revoked group connection
--     re-checks.
--   - auto_accept only on a group connection: a side trigger refuses auto_accept = true when the connection's
--     kind is not 'group' (the plan's ruling 8).
--   - A side's customer, supplier, accounts and dimensions must belong to the side's own company.
--   - Messages: UNIQUE (from_company_id, source_doc_type, source_doc_id, kind) (ruling 10); from and to are
--     exactly the connection's two companies; a message is inserted only while the connection is active; the
--     sender can only insert, the receiver can only move a pending message on (a handled one is final).
--   - Stamps: invited_by, accepted_by, revoked_by, handled_by are the session user (auth.uid()), the times the
--     clock, set by the trigger whatever was sent.
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930).
--
-- OLD COLOUR: nothing in the previous release reads or writes these tables.
-- LOCKS: only new objects are created (no lock on an existing table beyond the catalogue).
--
-- Rollback (code first):
--   DROP TABLE IF EXISTS intercompany_document_links, intercompany_messages, company_connection_keys,
--     intercompany_connection_sides, intercompany_connections;
--   DROP FUNCTION IF EXISTS public.intercompany_same_group(uuid, uuid), public.intercompany_connections_guard(),
--     public.intercompany_sides_guard(), public.intercompany_messages_guard(), public.intercompany_links_guard();
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_connections_ordered CHECK (company_low_id < company_high_id),
  CONSTRAINT intercompany_connections_pair UNIQUE (company_low_id, company_high_id),
  CONSTRAINT intercompany_connections_inviter CHECK (invited_by_company_id IN (company_low_id, company_high_id)),
  CONSTRAINT intercompany_connections_active_stamp CHECK (status <> 'active' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT intercompany_connections_revoked_stamp CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_intercompany_connections_high ON intercompany_connections (company_high_id);

CREATE TABLE IF NOT EXISTS intercompany_connection_sides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES intercompany_connections(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  settlement_mode TEXT NOT NULL DEFAULT 'cash' CHECK (settlement_mode IN ('cash', 'loan')),
  loan_account_id UUID REFERENCES gl_accounts(id) ON DELETE SET NULL,
  default_expense_account_id UUID REFERENCES gl_accounts(id) ON DELETE SET NULL,
  default_cc1_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL,
  default_cc2_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL,
  default_bu_id UUID REFERENCES business_units(id) ON DELETE SET NULL,
  auto_accept BOOLEAN NOT NULL DEFAULT false,
  cutover_date DATE,
  -- NULL = no interest (the default); P7 reads it.
  interest_rate_pct NUMERIC(7,4) CHECK (interest_rate_pct IS NULL OR (interest_rate_pct >= 0 AND interest_rate_pct <= 100)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_sides_one_per_company UNIQUE (connection_id, company_id),
  CONSTRAINT intercompany_sides_distinct CHECK (company_id <> partner_company_id)
);

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
  source_doc_type TEXT NOT NULL CHECK (char_length(source_doc_type) BETWEEN 1 AND 50),
  source_doc_id UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed', 'failed')),
  target_doc_type TEXT CHECK (target_doc_type IS NULL OR char_length(target_doc_type) BETWEEN 1 AND 50),
  target_doc_id UUID,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 2000),
  error TEXT CHECK (error IS NULL OR char_length(error) <= 4000),
  handled_by VARCHAR(255),
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_messages_distinct CHECK (from_company_id <> to_company_id),
  CONSTRAINT intercompany_messages_once UNIQUE (from_company_id, source_doc_type, source_doc_id, kind),
  CONSTRAINT intercompany_messages_reject_reason CHECK (status <> 'rejected' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);
CREATE INDEX IF NOT EXISTS idx_intercompany_messages_inbox ON intercompany_messages (to_company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intercompany_messages_outbox ON intercompany_messages (from_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intercompany_messages_connection ON intercompany_messages (connection_id);

CREATE TABLE IF NOT EXISTS intercompany_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES intercompany_connections(id) ON DELETE CASCADE,
  -- company_a is the connection's low company, company_b its high company (the guard enforces it).
  company_a_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_a_type TEXT NOT NULL CHECK (char_length(doc_a_type) BETWEEN 1 AND 50),
  doc_a_id UUID NOT NULL,
  company_b_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_b_type TEXT NOT NULL CHECK (char_length(doc_b_type) BETWEEN 1 AND 50),
  doc_b_id UUID NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('mirror', 'manual_pairing')),
  created_by VARCHAR(255) NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_links_doc_a UNIQUE (connection_id, doc_a_type, doc_a_id),
  CONSTRAINT intercompany_links_doc_b UNIQUE (connection_id, doc_b_type, doc_b_id)
);
CREATE INDEX IF NOT EXISTS idx_intercompany_links_company_b ON intercompany_document_links (company_b_id);

-- ── 2. Guards (SECURITY INVOKER: they read under the caller's own RLS) ─────

-- True when both companies are CURRENT members of one group, as the caller sees the membership rows.
CREATE OR REPLACE FUNCTION public.intercompany_same_group(p_low uuid, p_high uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_group_members a
      JOIN company_group_members b ON b.group_id = a.group_id
     WHERE a.company_id = p_low AND b.company_id = p_high
       AND a.left_date IS NULL AND b.left_date IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.intercompany_connections_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'group' THEN
      IF NEW.status <> 'active' THEN
        RAISE EXCEPTION 'a group connection is created active' USING ERRCODE = '23514';
      END IF;
      IF NOT public.intercompany_same_group(NEW.company_low_id, NEW.company_high_id) THEN
        RAISE EXCEPTION 'a group connection needs both companies to be current members of one group' USING ERRCODE = '23514';
      END IF;
      NEW.accepted_by := auth.uid();
      NEW.accepted_at := clock_timestamp();
    ELSE
      IF NEW.status <> 'pending' THEN
        RAISE EXCEPTION 'an external connection is created pending and accepted by the other company' USING ERRCODE = '23514';
      END IF;
      NEW.accepted_by := NULL;
      NEW.accepted_at := NULL;
    END IF;
    NEW.invited_by := COALESCE(auth.uid(), NEW.invited_by);
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
    RAISE EXCEPTION 'a connection changes only its status' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  NEW.accepted_by := OLD.accepted_by;
  NEW.accepted_at := OLD.accepted_at;
  NEW.revoked_by := OLD.revoked_by;
  NEW.revoked_at := OLD.revoked_at;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'a connection changes status through a signed-in user' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'revoked' THEN
    NEW.revoked_by := auth.uid();
    NEW.revoked_at := clock_timestamp();
  ELSIF OLD.status = 'pending' AND NEW.status = 'active' THEN
    IF app.current_company_id() IS NOT DISTINCT FROM OLD.invited_by_company_id THEN
      RAISE EXCEPTION 'an invitation is accepted by the other company' USING ERRCODE = '42501';
    END IF;
    NEW.accepted_by := auth.uid();
    NEW.accepted_at := clock_timestamp();
  ELSIF OLD.status = 'revoked' AND NEW.status = 'active' THEN
    IF OLD.kind <> 'group' THEN
      RAISE EXCEPTION 'a revoked external connection is invited again, not re-activated' USING ERRCODE = '23514';
    END IF;
    IF NOT public.intercompany_same_group(OLD.company_low_id, OLD.company_high_id) THEN
      RAISE EXCEPTION 'a group connection needs both companies to be current members of one group' USING ERRCODE = '23514';
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

CREATE OR REPLACE FUNCTION public.intercompany_sides_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
BEGIN
  SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
  END IF;
  IF NOT ((NEW.company_id = conn.company_low_id AND NEW.partner_company_id = conn.company_high_id)
       OR (NEW.company_id = conn.company_high_id AND NEW.partner_company_id = conn.company_low_id)) THEN
    RAISE EXCEPTION 'a side belongs to one of the connection''s two companies, facing the other' USING ERRCODE = '23514';
  END IF;
  IF NEW.auto_accept AND conn.kind <> 'group' THEN
    RAISE EXCEPTION 'auto-accept is only for a group connection' USING ERRCODE = '23514';
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
  IF TG_OP = 'UPDATE' AND (NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
                           OR NEW.partner_company_id IS DISTINCT FROM OLD.partner_company_id) THEN
    RAISE EXCEPTION 'a side keeps its connection and its company' USING ERRCODE = '23514';
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
    NEW.status := 'pending';
    NEW.target_doc_type := NULL;
    NEW.target_doc_id := NULL;
    NEW.reason := NULL;
    NEW.error := NULL;
    NEW.handled_by := NULL;
    NEW.handled_at := NULL;
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
  IF OLD.status IN ('accepted', 'rejected', 'dismissed') THEN
    RAISE EXCEPTION 'a handled message is final' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status <> 'pending' THEN
    NEW.handled_by := auth.uid();
    NEW.handled_at := clock_timestamp();
  ELSE
    NEW.handled_by := OLD.handled_by;
    NEW.handled_at := OLD.handled_at;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_messages_guard ON intercompany_messages;
CREATE TRIGGER trg_intercompany_messages_guard BEFORE INSERT OR UPDATE ON intercompany_messages
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_messages_guard();
ALTER TABLE intercompany_messages ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard;

CREATE OR REPLACE FUNCTION public.intercompany_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  conn intercompany_connections%ROWTYPE;
BEGIN
  SELECT * INTO conn FROM intercompany_connections WHERE id = NEW.connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such connection' USING ERRCODE = '23503';
  END IF;
  IF conn.status <> 'active' THEN
    RAISE EXCEPTION 'documents are linked only on an active connection' USING ERRCODE = '23514';
  END IF;
  IF NEW.company_a_id <> conn.company_low_id OR NEW.company_b_id <> conn.company_high_id THEN
    RAISE EXCEPTION 'a link names the connection''s low company as A and its high company as B' USING ERRCODE = '23514';
  END IF;
  NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_links_guard ON intercompany_document_links;
CREATE TRIGGER trg_intercompany_links_guard BEFORE INSERT ON intercompany_document_links
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_links_guard();
ALTER TABLE intercompany_document_links ENABLE ALWAYS TRIGGER trg_intercompany_links_guard;

-- ── 3. Tenancy: 944's form; parties see a shared row, one company sees its own ──

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

-- ── 4. Privileges: 348's default gave app_user every command; take it back, grant per column ──

REVOKE INSERT, UPDATE, DELETE ON intercompany_connections FROM app_user;
GRANT SELECT ON intercompany_connections TO app_user;
GRANT INSERT (company_low_id, company_high_id, kind, status, invited_by_company_id) ON intercompany_connections TO app_user;
GRANT UPDATE (status) ON intercompany_connections TO app_user;

REVOKE INSERT, UPDATE, DELETE ON intercompany_connection_sides FROM app_user;
GRANT SELECT ON intercompany_connection_sides TO app_user;
GRANT INSERT (connection_id, company_id, partner_company_id, customer_id, supplier_id, settlement_mode, loan_account_id,
              default_expense_account_id, default_cc1_id, default_cc2_id, default_bu_id, auto_accept, cutover_date,
              interest_rate_pct) ON intercompany_connection_sides TO app_user;
GRANT UPDATE (customer_id, supplier_id, settlement_mode, loan_account_id, default_expense_account_id, default_cc1_id,
              default_cc2_id, default_bu_id, auto_accept, cutover_date, interest_rate_pct) ON intercompany_connection_sides TO app_user;

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
GRANT INSERT (connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin)
  ON intercompany_document_links TO app_user;

REVOKE ALL ON FUNCTION public.intercompany_connections_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_sides_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_messages_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intercompany_links_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_same_group(uuid, uuid) TO app_user;

-- The service pool reaches the tables through the mirrors 915 creates from the app_user policies.
SELECT public.app_service_sync_policies();
