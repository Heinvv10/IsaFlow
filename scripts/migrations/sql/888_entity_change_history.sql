-- 888: Entity change history (forensic-controls rebuild, step 3; Hein's
-- decisions 2026-10-10). Every write that lands on a master-data row records
-- one append-only entity_changes row with the row's before and after, who did
-- it and through which channel — whoever writes: a withAuth route, an MCP
-- token, Login-as, the platform-admin portal, a SECURITY DEFINER function
-- (881/883/885/886, create_company_with_owner), a script, raw SQL.
--
--   Entities (decision 1, "full master set"): suppliers, customers,
--   gl_accounts (bank accounts are gl_accounts rows), payroll_employees,
--   company_users, company_invitations, company_user_permissions, companies
--   (only the tax / VAT / bank / year-end / lockdown / FX / status columns),
--   approval_rules, approval_enforcement. Bank rules keep 877's history.
--   payroll_bank_details is not tracked: no company_id and no app writer.
--
--   Capture is the DATABASE's (a trigger), not the services': the census
--   found 100+ writer sites, several outside the app layer, and none of them
--   recorded values. One generic AFTER ROW trigger, entity_change_capture,
--   SECURITY DEFINER so that NO other role needs INSERT on the history:
--   app_user and platform_admin hold SELECT only (app_user) or nothing, so a
--   member cannot forge a row by raw SQL (stronger than 877, where app_user
--   keeps INSERT). EXECUTE on it is revoked from everyone, so nobody but its
--   owner can attach it to a table of their own (a temp table) and feed it a
--   forged row; a trigger fires without an EXECUTE check.
--
--   Actor: auth.uid() (the request's JWT subject), else 'db:' || session_user.
--   Channel, from the request the write ran in:
--     platform_admin  the portal's connection (role platform_admin);
--     system          no JWT claims (scripts, invite acceptance, provisioning);
--     token           claims without a session_id (MCP / PAT / extension);
--     impersonation   a Login-as session (impersonation_sessions) — the
--                     platform admin behind it is recorded as `impersonator`;
--     session         a person in their own session.
--   db_role is the role the session set (SET ROLE app_user), which a
--   SECURITY DEFINER caller does not change, and login_role its login. Inside
--   a definer (881's approval_enforcement_set, 883's guards, …) auth.uid() is
--   still the request's subject, so the person is recorded, never the owner.
--
--   Every trigger here is ENABLE ALWAYS: it fires under
--   session_replication_role = replica too (a superuser's bulk load), as the
--   OAuth trust-flag guard does (scripts/ci/oauthTrustFlagRule.ts).
--
--   No-op writes record nothing: an UPDATE whose projection (the row minus
--   created_at / updated_at and each table's derived or secret columns) is
--   unchanged. Secrets are never stored: the Netcash keys and an invitation's
--   token are recorded as a short sha256 digest, so a change is visible and the
--   secret is not. A row whose id changes is recorded under both ids.
--
--   Retention: kept until the company is purged (877's recipe — the history
--   cascades with its company, the one delete the append-only trigger lets
--   through). A deleted entity keeps its history (no FK to the entity).
--
--   Reading (decision 4): tenant-bound and role-bound in RLS, not only in the
--   route. Suppliers, customers and GL accounts: any member. Payroll
--   employees: owner / admin / manager (withPayrollDetailAccess's set).
--   Members, invitations, permissions, the company, approval rules and
--   switches: owner / admin. Bank account and ID / tax numbers are stored in
--   full and masked by the API for everyone but owner / admin (decision 2).
--
-- Boundary (as N1, 876, 877): the app connects as a login role that drops to
-- app_user, so injected SQL can RESET ROLE or forge its claims. These objects
-- bind application code paths and app_user / platform_admin statements, not
-- an attacker already running arbitrary SQL. Nor the OWNER: the table and the
-- capture are owned by the role that applies this migration — on production
-- the app's own login (deploy.sh migrates with the app's DATABASE_URL) — which
-- can disable or drop the guards, or forge a row from a trigger of its own; so
-- injected SQL that RESETs ROLE can erase history (breaker #696 R7). The guards
-- refuse its plain UPDATE / DELETE / INSERT: an accident is refused, a
-- deliberate owner is not. That login already owns, through migration_admin,
-- every tracked table and so can switch the capture off; closing this means a
-- history owner the login is not a member of, which is N3's work.
--
-- Erasure: the history keeps a deleted entity's values (bank account, ID and
-- tax numbers included) until its company is purged; there is no per-person
-- erasure path. Hein to decide whether POPIA needs one (review of PR #696, M2).
--
-- Not closed here: Postgres's statistics views (pg_stat_user_tables.n_tup_ins,
-- pg_class.reltuples) are readable by every role and count every tenant's rows
-- in every table of this shared schema — entity_changes is no different from
-- suppliers there. The history's own counters (seq, txid, the seq sequence) are
-- not readable by app_user.
--
-- Cost: about 0.4 ms per tracked row written (5 000-row bulk INSERT / UPDATE:
-- ~2 s with capture, ~0.1 s without, measured on a fixture). TRUNCATE of a tracked table
-- fires no row trigger; no role but their owners holds TRUNCATE on them
-- (asserted below).

-- ── 1. The history ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_changes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          BIGINT GENERATED ALWAYS AS IDENTITY,
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN (
    'supplier', 'customer', 'gl_account', 'payroll_employee', 'company_user', 'company_invitation',
    'company_user_permission', 'company', 'approval_rule', 'approval_enforcement')),
  entity_id    UUID NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  -- The projection keys whose value moved (every non-null key for a create
  -- or a delete), sorted.
  changed      TEXT[] NOT NULL,
  before       JSONB,
  after        JSONB,
  -- users.id is character varying(255), not uuid; 'db:<login role>' when the
  -- write ran with no JWT subject.
  actor        TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('session', 'impersonation', 'token', 'platform_admin', 'system')),
  impersonator TEXT,
  session_id   TEXT,
  db_role      TEXT NOT NULL,
  login_role   TEXT NOT NULL,
  txid         BIGINT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT entity_changes_shape_ck CHECK ((op = 'create') = (before IS NULL) AND (op = 'delete') = (after IS NULL)),
  CONSTRAINT entity_changes_impersonator_ck CHECK ((channel = 'impersonation') = (impersonator IS NOT NULL))
);
-- Readers page by (recorded_at, id) — seq and txid are platform-wide counters
-- and are not readable by app_user (below).
CREATE INDEX IF NOT EXISTS entity_changes_entity_recorded_idx ON entity_changes (company_id, entity_type, entity_id, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS entity_changes_feed_recorded_idx ON entity_changes (company_id, recorded_at DESC, id DESC);

ALTER TABLE entity_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_changes_read ON entity_changes;
CREATE POLICY entity_changes_read ON entity_changes
  FOR SELECT TO app_user
  USING (
    company_id = app.current_company_id()
    AND company_id IN (SELECT auth.user_companies())
    AND CASE
      WHEN entity_type IN ('supplier', 'customer', 'gl_account') THEN true
      WHEN entity_type = 'payroll_employee'
        THEN COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin', 'manager'), false)
      ELSE COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin'), false)
    END);

-- Append-only by grant: every non-owner role loses everything (default
-- privileges grant app_user and platform_admin ALL on a new table), then
-- app_user gets SELECT back. Nobody but the owner may INSERT: the capture
-- trigger writes as its owner.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'entity_changes'
      AND grantee <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                      WHERE c.oid = 'public.entity_changes'::pg_catalog.regclass)
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON public.entity_changes FROM %I', r.grantee);
  END LOOP;
  REVOKE ALL ON public.entity_changes FROM PUBLIC;
END $$;
-- The identity sequence behind seq: default privileges (348) give app_user and
-- platform_admin USAGE / SELECT on new sequences, and its last_value is the same
-- platform-wide counter (security review of 1753e2b0) — nobody but the owner.
DO $$
DECLARE
  v_seq pg_catalog.regclass := pg_catalog.pg_get_serial_sequence('public.entity_changes', 'seq')::pg_catalog.regclass;
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee) AS grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('S', c.relowner))) a
    WHERE c.oid = v_seq AND a.grantee <> c.relowner AND a.grantee <> 0
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON SEQUENCE %s FROM %I', v_seq, r.grantee);
  END LOOP;
  EXECUTE pg_catalog.format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', v_seq);
END $$;

-- Every column but seq and txid: both count every tenant's writes, so a member
-- reading them could count another company's activity (breaker #696 R3 / r2 #2).
GRANT SELECT (id, company_id, entity_type, entity_id, op, changed, before, after, actor, channel, impersonator,
              session_id, db_role, login_role, recorded_at) ON entity_changes TO app_user;

-- What an inserted row is, whoever inserts it: only the capture trigger
-- (trigger depth >= 2: the capture runs at depth >= 1 and this guard one
-- deeper) — a direct INSERT by the owner is refused too. The sequence, the
-- clock and the transaction are stamped here, never taken from the caller.
CREATE OR REPLACE FUNCTION public.entity_changes_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'entity_changes: a change is recorded by the changed table itself, not inserted'
      USING ERRCODE = '42501';
  END IF;
  NEW.seq := pg_catalog.nextval(pg_catalog.pg_get_serial_sequence('public.entity_changes', 'seq'));
  NEW.recorded_at := pg_catalog.clock_timestamp();
  NEW.txid := pg_catalog.txid_current();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS entity_changes_insert_guard ON entity_changes;
CREATE TRIGGER entity_changes_insert_guard
  BEFORE INSERT ON entity_changes
  FOR EACH ROW EXECUTE FUNCTION public.entity_changes_insert_guard();

-- Append-only for every role, the owner's plain statements included (the owner
-- can still disable the trigger: see the boundary above). The one exception is
-- the cascade from a purged company (876/877's recipe): by then the company
-- row is gone.
CREATE OR REPLACE FUNCTION public.entity_changes_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Nested, not AND: a TRUNCATE has no OLD row to read.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;
DROP TRIGGER IF EXISTS entity_changes_append_only ON entity_changes;
CREATE TRIGGER entity_changes_append_only
  BEFORE UPDATE OR DELETE ON entity_changes
  FOR EACH ROW EXECUTE FUNCTION public.entity_changes_append_only();
DROP TRIGGER IF EXISTS entity_changes_no_truncate ON entity_changes;
CREATE TRIGGER entity_changes_no_truncate
  BEFORE TRUNCATE ON entity_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_changes_append_only();
ALTER TABLE entity_changes ENABLE ALWAYS TRIGGER entity_changes_insert_guard;
ALTER TABLE entity_changes ENABLE ALWAYS TRIGGER entity_changes_append_only;
ALTER TABLE entity_changes ENABLE ALWAYS TRIGGER entity_changes_no_truncate;

-- ── 2. What is recorded of a row ──────────────────────────────────────────
-- A Netcash key is a credential: record that it changed, never what it is.
CREATE OR REPLACE FUNCTION public.entity_change_secret_digest(p_value pg_catalog.text)
RETURNS pg_catalog.text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p_value IS NULL OR p_value = '' THEN NULL
    ELSE 'sha256:' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_value, 'UTF8')), 'hex'), 12) END
$$;

-- The row as history records it. Every column by default, so a column added
-- later is recorded too, minus the bookkeeping (id, created_at, updated_at)
-- and each table's derived or secret columns. companies is the exception: an
-- allow-list (it carries ~180 display and template columns).
CREATE OR REPLACE FUNCTION public.entity_change_projection(p_type pg_catalog.text, p_row pg_catalog.jsonb)
RETURNS pg_catalog.jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_type
    WHEN 'company' THEN
      (SELECT COALESCE(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::pg_catalog.jsonb)
       FROM pg_catalog.jsonb_each(p_row) e
       WHERE e.key = ANY (ARRAY[
         'name', 'registered_name', 'trading_name', 'entity_type', 'registration_number', 'vat_number', 'tax_number',
         'tax_office', 'vat_period', 'vat_period_alignment', 'vat_system_type', 'paye_reference_number',
         'sdl_reference_number', 'uif_reference_number', 'tax_practitioner_reg_number', 'tax_practitioner_name',
         'financial_year_start', 'lockdown_enabled', 'lockdown_date', 'default_currency', 'functional_currency',
         'fx_documents_enabled', 'bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type',
         'netcash_enabled', 'status', 'is_active', 'idle_timeout_minutes',
         -- Where customers are told to pay, and the addresses and mail that carry it
         -- (breaker #696 R1): a changed "pay into" line is as material as the account.
         'portal_payment_instructions', 'portal_allow_payments', 'portal_welcome_message', 'email', 'billing_email',
         'phone', 'mobile', 'fax', 'website', 'email_always_cc', 'email_use_for_communication', 'email_use_service_from',
         -- The address printed on every invoice and credit note (pdfShared.getCompanyDetailsFromCompany) and the
         -- registered / physical ones (breaker #696 r2 #3).
         'address_line1', 'address_line2', 'city', 'province', 'postal_code', 'country',
         'physical_address_line1', 'physical_address_line2', 'physical_city', 'physical_province', 'physical_postal_code',
         'registered_address',
         'invoice_email_subject', 'invoice_email_body', 'invoice_email_signature',
         'quote_email_subject', 'quote_email_body', 'quote_email_signature',
         'statement_email_subject', 'statement_email_body', 'statement_email_signature',
         'credit_note_email_subject', 'credit_note_email_body', 'credit_note_email_signature',
         'sales_order_email_subject', 'sales_order_email_body', 'sales_order_email_signature',
         'recurring_invoice_email_subject', 'recurring_invoice_email_body', 'recurring_invoice_email_signature',
         'chase_auto_send_enabled', 'whatsapp_chase_enabled', 'client_query_whatsapp',
         'share_anonymised_signals']::pg_catalog.text[]))
      || pg_catalog.jsonb_build_object(
           'netcash_service_key', public.entity_change_secret_digest(p_row ->> 'netcash_service_key'),
           'netcash_payouts_key', public.entity_change_secret_digest(p_row ->> 'netcash_payouts_key'))
    ELSE p_row - ARRAY['id', 'created_at', 'updated_at']::pg_catalog.text[] - CASE p_type
      -- Who set the current bank details (867): derived; this history says who.
      WHEN 'supplier' THEN ARRAY['bank_details_setters']::pg_catalog.text[]
      -- A member's own default company: their preference, not an access change.
      WHEN 'company_user' THEN ARRAY['is_default']::pg_catalog.text[]
      -- Mail delivery state. The token (a credential) is replaced by its digest
      -- below; gotrue_user_id is the account acceptance sets a password on, so it
      -- is recorded (breaker #696 R6).
      WHEN 'company_invitation' THEN ARRAY['token', 'email_sent_at', 'email_error']::pg_catalog.text[]
      ELSE ARRAY[]::pg_catalog.text[] END
      || CASE WHEN p_type = 'company_invitation'
           THEN pg_catalog.jsonb_build_object('token', public.entity_change_secret_digest(p_row ->> 'token'))
           ELSE '{}'::pg_catalog.jsonb END
  END
$$;

-- The keys whose value differs (a missing key counts as JSON null), sorted.
CREATE OR REPLACE FUNCTION public.entity_change_keys(p_before pg_catalog.jsonb, p_after pg_catalog.jsonb)
RETURNS pg_catalog.text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(pg_catalog.array_agg(k ORDER BY k), ARRAY[]::pg_catalog.text[])
  FROM (SELECT pg_catalog.jsonb_object_keys(COALESCE(p_before, '{}'::pg_catalog.jsonb)) AS k
        UNION SELECT pg_catalog.jsonb_object_keys(COALESCE(p_after, '{}'::pg_catalog.jsonb))) ks
  WHERE COALESCE(p_before -> k, 'null'::pg_catalog.jsonb) IS DISTINCT FROM COALESCE(p_after -> k, 'null'::pg_catalog.jsonb)
$$;

-- ── 3. The capture ────────────────────────────────────────────────────────
-- TG_ARGV[0] is the entity type. SECURITY DEFINER: it inserts as its owner
-- (who alone may), and reads impersonation_sessions whatever the writer may
-- see. Every relation is schema-qualified; pg_temp is searched last.
CREATE OR REPLACE FUNCTION public.entity_change_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type pg_catalog.text := TG_ARGV[0];
  v_old pg_catalog.jsonb;
  v_new pg_catalog.jsonb;
  v_before pg_catalog.jsonb;
  v_after pg_catalog.jsonb;
  v_claims pg_catalog.jsonb := NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb;
  v_subject pg_catalog.text;
  v_sid pg_catalog.text;
  v_role pg_catalog.text;
  v_channel pg_catalog.text;
  v_impersonator pg_catalog.text;
  v_company pg_catalog.uuid;
  v_companies pg_catalog.uuid[];
  v_entity pg_catalog.uuid;
  v_entities pg_catalog.uuid[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old := pg_catalog.to_jsonb(OLD);
    v_before := public.entity_change_projection(v_type, v_old);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := pg_catalog.to_jsonb(NEW);
    v_after := public.entity_change_projection(v_type, v_new);
  END IF;
  -- A re-keyed row (its id changed): the projection drops id, so put both ids
  -- in, and record the change under each (breaker #696 R2) — the old id's
  -- timeline ends with it and the new one's starts with it.
  IF TG_OP = 'UPDATE' AND v_old ->> 'id' IS DISTINCT FROM v_new ->> 'id' THEN
    v_before := v_before || pg_catalog.jsonb_build_object('id', v_old -> 'id');
    v_after := v_after || pg_catalog.jsonb_build_object('id', v_new -> 'id');
  END IF;
  IF TG_OP = 'UPDATE' AND v_before = v_after THEN
    RETURN NULL;
  END IF;

  -- The company (or companies: a row moved between tenants is recorded in
  -- both) whose history this is. A company being purged takes its history
  -- with it, so a row deleted by that cascade records nothing (its FK would
  -- refuse it); a row with no company (legacy global approval rules) neither.
  SELECT pg_catalog.array_agg(DISTINCT c ORDER BY c) INTO v_companies
  FROM pg_catalog.unnest(ARRAY[
    CASE WHEN v_type = 'company' THEN v_old ->> 'id' ELSE v_old ->> 'company_id' END,
    CASE WHEN v_type = 'company' THEN v_new ->> 'id' ELSE v_new ->> 'company_id' END]) AS c
  WHERE c IS NOT NULL;

  v_subject := NULLIF(v_claims ->> 'sub', '');
  v_sid := NULLIF(v_claims ->> 'session_id', '');
  v_role := CASE pg_catalog.current_setting('role') WHEN 'none' THEN session_user::pg_catalog.text
                                                    ELSE pg_catalog.current_setting('role') END;
  IF v_role = 'platform_admin' THEN
    v_channel := 'platform_admin';
  ELSIF v_subject IS NULL THEN
    v_channel := 'system';
  ELSIF v_sid IS NULL THEN
    v_channel := 'token';
  ELSE
    SELECT s.actor_user_id INTO v_impersonator FROM public.impersonation_sessions s WHERE s.session_id = v_sid;
    v_channel := CASE WHEN v_impersonator IS NULL THEN 'session' ELSE 'impersonation' END;
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT e::pg_catalog.uuid) INTO v_entities
  FROM pg_catalog.unnest(ARRAY[v_old ->> 'id', v_new ->> 'id']) AS e WHERE e IS NOT NULL;

  FOREACH v_company IN ARRAY COALESCE(v_companies, ARRAY[]::pg_catalog.uuid[]) LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = v_company);
    FOREACH v_entity IN ARRAY v_entities LOOP
    INSERT INTO public.entity_changes (company_id, entity_type, entity_id, op, changed, before, after, actor, channel,
                                       impersonator, session_id, db_role, login_role, txid, recorded_at)
    VALUES (v_company, v_type, v_entity,
            CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'DELETE' THEN 'delete' ELSE 'update' END,
            public.entity_change_keys(v_before, v_after), v_before, v_after,
            COALESCE(v_subject, 'db:' || session_user), v_channel,
            CASE WHEN v_channel = 'impersonation' THEN v_impersonator END, v_sid, v_role, session_user,
            0, pg_catalog.clock_timestamp());
    END LOOP;
  END LOOP;
  RETURN NULL;
END
$$;

DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('suppliers', 'supplier'), ('customers', 'customer'), ('gl_accounts', 'gl_account'),
      ('payroll_employees', 'payroll_employee'), ('company_users', 'company_user'),
      ('company_invitations', 'company_invitation'), ('company_user_permissions', 'company_user_permission'),
      ('companies', 'company'), ('approval_rules', 'approval_rule'), ('approval_enforcement', 'approval_enforcement')
    ) v(tbl, typ)
  LOOP
    EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS entity_change_capture ON public.%I', t.tbl);
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER entity_change_capture AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.entity_change_capture(%L)', t.tbl, t.typ);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER entity_change_capture', t.tbl);
  END LOOP;
END $$;

-- Nobody but the owner may execute any of them: the capture is reached only
-- as a trigger, and the helpers only from it. Default privileges may have
-- granted EXECUTE to app_user / platform_admin; every grantee is enumerated.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS fn, pg_catalog.pg_get_userbyid(a.grantee) AS grantee
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = ANY (ARRAY[
        'public.entity_change_capture()', 'public.entity_change_projection(pg_catalog.text,pg_catalog.jsonb)',
        'public.entity_change_keys(pg_catalog.jsonb,pg_catalog.jsonb)', 'public.entity_change_secret_digest(pg_catalog.text)',
        'public.entity_changes_insert_guard()', 'public.entity_changes_append_only()']::pg_catalog.regprocedure[]::pg_catalog.oid[])
      AND a.grantee <> p.proowner AND a.grantee <> 0
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, r.grantee);
  END LOOP;
  REVOKE ALL ON FUNCTION public.entity_change_capture() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.entity_change_projection(pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.entity_change_keys(pg_catalog.jsonb, pg_catalog.jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.entity_change_secret_digest(pg_catalog.text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.entity_changes_insert_guard() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.entity_changes_append_only() FROM PUBLIC;
END $$;

-- ── 4. Assertions: refuse to ship it any other way ────────────────────────
-- The exemption is 872's (#680): only the role RUNNING this migration, when
-- it inherits the owner (the deploy role on production, a member of
-- migration_admin). Any other member of the owner still refuses it.
DO $$
DECLARE
  v_owner pg_catalog.oid := (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.entity_changes'::pg_catalog.regclass);
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
  v_table pg_catalog.text;
  v_fn pg_catalog.text;
BEGIN
  FOR v_role IN
    SELECT r.rolname FROM pg_catalog.pg_roles r
    WHERE NOT r.rolsuper AND r.oid <> v_owner AND r.rolname !~ '^pg_'
      AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE'))
    UNION ALL SELECT 'public'
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.entity_changes', v_priv) THEN
        RAISE EXCEPTION 'migration 888: % still holds % on entity_changes', v_role, v_priv;
      END IF;
    END LOOP;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
      IF pg_catalog.has_any_column_privilege(v_role, 'public.entity_changes', v_priv) THEN
        RAISE EXCEPTION 'migration 888: % still holds column % on entity_changes', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT pg_catalog.has_column_privilege('app_user', 'public.entity_changes', 'recorded_at', 'SELECT')
     OR pg_catalog.has_column_privilege('app_user', 'public.entity_changes', 'seq', 'SELECT')
     OR pg_catalog.has_column_privilege('app_user', 'public.entity_changes', 'txid', 'SELECT') THEN
    RAISE EXCEPTION 'migration 888: app_user must read entity_changes but not seq or txid';
  END IF;
  -- The request roles (a maintenance role in pg_read_all_data reads every
  -- sequence and table by design, as it reads seq itself).
  FOREACH v_role IN ARRAY ARRAY['app_user', 'platform_admin', 'public'] LOOP
    IF pg_catalog.has_sequence_privilege(v_role, pg_catalog.pg_get_serial_sequence('public.entity_changes', 'seq'), 'SELECT')
       OR pg_catalog.has_sequence_privilege(v_role, pg_catalog.pg_get_serial_sequence('public.entity_changes', 'seq'), 'USAGE') THEN
      RAISE EXCEPTION 'migration 888: % may read the entity_changes seq sequence', v_role;
    END IF;
  END LOOP;

  -- A TRUNCATE fires no row trigger: no request role may erase a tracked
  -- table that way.
  -- A VALUES list, not FOREACH ... ARRAY: scripts/ci/migrationRlsRule.ts reads table names out of
  -- such an array as RLS-protected by this file, which these are not (their RLS is their own).
  FOR v_table IN SELECT x.tbl FROM (VALUES ('suppliers'), ('customers'), ('gl_accounts'), ('payroll_employees'),
      ('company_users'), ('company_invitations'), ('company_user_permissions'), ('companies'), ('approval_rules'),
      ('approval_enforcement')) x(tbl) LOOP
    FOREACH v_role IN ARRAY ARRAY['app_user', 'platform_admin', 'public'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'TRUNCATE') THEN
        RAISE EXCEPTION 'migration 888: % may TRUNCATE % (no history would be recorded)', v_role, v_table;
      END IF;
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = ('public.' || v_table)::pg_catalog.regclass AND t.tgname = 'entity_change_capture'
        AND t.tgenabled = 'A' AND t.tgfoid = 'public.entity_change_capture()'::pg_catalog.regprocedure
    ) THEN
      RAISE EXCEPTION 'migration 888: % has no ENABLE ALWAYS entity_change_capture trigger', v_table;
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.entity_changes'::pg_catalog.regclass AND NOT t.tgisinternal AND t.tgenabled = 'A') <> 3 THEN
    RAISE EXCEPTION 'migration 888: entity_changes must carry exactly its three ENABLE ALWAYS guards';
  END IF;

  -- FORCE RLS binds the capture's owner too: one without BYPASSRLS would be
  -- refused the insert and every tracked write would fail.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public.entity_change_capture()'::pg_catalog.regprocedure AND p.prosecdef AND (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 888: entity_change_capture must be SECURITY DEFINER with an owner that bypasses RLS';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
      'public.entity_change_capture()', 'public.entity_change_projection(pg_catalog.text,pg_catalog.jsonb)',
      'public.entity_change_keys(pg_catalog.jsonb,pg_catalog.jsonb)', 'public.entity_change_secret_digest(pg_catalog.text)',
      'public.entity_changes_insert_guard()', 'public.entity_changes_append_only()'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_fn::pg_catalog.regprocedure
        AND p.proconfig[pg_catalog.array_upper(p.proconfig, 1)] ~ '^search_path=.*pg_temp$'
    ) THEN
      RAISE EXCEPTION 'migration 888: % must pin search_path with pg_temp last', v_fn;
    END IF;
    FOR v_role IN
      SELECT r.rolname FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.rolname !~ '^pg_'
        AND r.oid <> (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_fn::pg_catalog.regprocedure)
        AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid,
                 (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_fn::pg_catalog.regprocedure), 'USAGE'))
      UNION ALL SELECT 'public'
    LOOP
      IF pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 888: % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
END $$;
