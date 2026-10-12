-- 890: Audit snapshots, check runs and their seal (forensic-controls rebuild,
-- step 4; Hein's decisions 2026-10-12).
--
--   A snapshot freezes a company's books at an accounting-date cutoff: the
--   trial balance by account, every POSTED journal and line dated on or before
--   the cutoff as a canonical row with its material hash, ageing and control
--   totals, the master-data high-water mark (the newest recorded_at of the
--   change history at the time) and the check run taken with it. Document
--   hashes only, never bytes. Taken by hand (owner / admin) or automatically
--   when a fiscal period is closed or locked, a VAT period locked or a year
--   closed (the closer: owner / admin / manager). A refused automatic attempt
--   is recorded as status 'failed' with its reason and nothing else; one whose
--   books have not moved since a sealed snapshot at the same cutoff is recorded
--   as 'unchanged', pointing at that snapshot (no second full copy).
--
--   CHAINED per company: every sealed snapshot carries seq (1, 2, 3, …) and the
--   previous sealed snapshot's hmac inside what its own hmac signs, so removing
--   or replacing one leaves a gap or a broken link that the chain check reports.
--
--   THE SEAL IS THE APP'S, NOT THE DATABASE'S. The service builds canonical
--   JSON of the whole snapshot, hashes it (SHA-256) and signs company | id |
--   hash | cutoff | taken_at with a server key (HMAC-SHA256) the database
--   never sees. A row forged or altered by SQL — by anyone, the owner
--   included — fails verification, which recomputes every material hash and
--   the canonical hash from the stored rows. What these tables add is that
--   the rows cannot be changed in place, so a valid seal stays valid and an
--   altered one is visible.
--
--   Every row is the current value of a record dated on or before the cutoff,
--   as at taken_at — not the historical database state.
--
--   Written ONLY through two SECURITY DEFINER writers, one call per run or
--   snapshot with every row in it: nobody but the owner holds INSERT, so rows
--   cannot be appended to a sealed snapshot later. The writer binds the row to
--   the request: taken_by = auth.uid(), the company is the request's company
--   GUC and a company the caller belongs to, taken_at = the transaction's
--   now(), the channel (session / impersonation / token) is read from the
--   request's claims, and the caller's role must allow the trigger.
--
--   Append-only for every role, the owner's plain statements included; the
--   one exception is the cascade from a purged company (888's recipe).
--   Retention: until the company is purged.
--
--   Reading: owner / admin / manager of the company (RLS, forced); the
--   external auditor reads only the exported pack through a portal session.
--
-- Boundary (as 876 / 877 / 888): the app connects as a login role that drops
-- to app_user, so injected SQL can RESET ROLE or forge its claims. The OWNER
-- of these tables (on production the app's own login, which applies
-- migrations) can disable the guards. Neither can produce a seal that
-- verifies without the signing key, which lives only in the app's
-- environment (AUDIT_SNAPSHOT_SIGNING_KEY).

-- ── 1. Check runs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_check_runs (
  id             UUID PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  as_at          DATE NOT NULL,
  period_start   DATE NOT NULL,
  taken_at       TIMESTAMPTZ NOT NULL,
  taken_by       TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('session', 'impersonation', 'token')),
  purpose        TEXT NOT NULL CHECK (purpose IN ('standalone', 'snapshot')),
  canonical_hash TEXT NOT NULL CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  hmac           TEXT NOT NULL CHECK (hmac ~ '^[0-9a-f]{64}$'),
  key_id         TEXT NOT NULL,
  totals         JSONB NOT NULL,
  CONSTRAINT audit_check_runs_company_id_key UNIQUE (company_id, id),
  CONSTRAINT audit_check_runs_window_ck CHECK (period_start <= as_at)
);
CREATE INDEX IF NOT EXISTS audit_check_runs_company_taken_idx ON audit_check_runs (company_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS audit_check_results (
  run_id         UUID NOT NULL,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  check_id       TEXT NOT NULL,
  check_version  INTEGER NOT NULL CHECK (check_version > 0),
  family         TEXT NOT NULL CHECK (family IN ('integrity', 'anomaly', 'journal_risk')),
  status         TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unknown')),
  population     INTEGER,
  finding_count  INTEGER NOT NULL,
  findings       JSONB NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
  PRIMARY KEY (run_id, check_id),
  CONSTRAINT audit_check_results_run_fk FOREIGN KEY (company_id, run_id)
    REFERENCES audit_check_runs (company_id, id) ON DELETE CASCADE
);

-- ── 2. Snapshots ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_snapshots (
  id                     UUID PRIMARY KEY,
  company_id             UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cutoff                 DATE NOT NULL,
  taken_at               TIMESTAMPTZ NOT NULL,
  taken_by               TEXT NOT NULL,
  channel                TEXT NOT NULL CHECK (channel IN ('session', 'impersonation', 'token')),
  trigger                TEXT NOT NULL CHECK (trigger IN ('manual', 'period_close', 'vat_lock', 'year_close')),
  status                 TEXT NOT NULL CHECK (status IN ('sealed', 'failed', 'unchanged')),
  failure_reason         TEXT,
  canonical_hash         TEXT CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  hmac                   TEXT CHECK (hmac ~ '^[0-9a-f]{64}$'),
  key_id                 TEXT,
  master_data_high_water TIMESTAMPTZ,
  totals                 JSONB NOT NULL,
  caveat                 TEXT NOT NULL,
  check_run_id           UUID,
  seq                    INTEGER CHECK (seq > 0),
  prev_hmac              TEXT CHECK (prev_hmac ~ '^[0-9a-f]{64}$'),
  same_as_snapshot_id    UUID,
  CONSTRAINT audit_snapshots_company_id_key UNIQUE (company_id, id),
  CONSTRAINT audit_snapshots_company_seq_key UNIQUE (company_id, seq),
  CONSTRAINT audit_snapshots_same_as_fk FOREIGN KEY (company_id, same_as_snapshot_id)
    REFERENCES audit_snapshots (company_id, id) ON DELETE CASCADE,
  CONSTRAINT audit_snapshots_run_fk FOREIGN KEY (company_id, check_run_id)
    REFERENCES audit_check_runs (company_id, id) ON DELETE CASCADE,
  CONSTRAINT audit_snapshots_shape_ck CHECK (
    (status = 'sealed' AND failure_reason IS NULL AND canonical_hash IS NOT NULL AND hmac IS NOT NULL AND key_id IS NOT NULL
      AND seq IS NOT NULL AND (seq > 1 OR prev_hmac IS NULL) AND same_as_snapshot_id IS NULL)
    OR (status = 'failed' AND failure_reason IS NOT NULL AND canonical_hash IS NULL AND hmac IS NULL AND check_run_id IS NULL
      AND seq IS NULL AND prev_hmac IS NULL AND same_as_snapshot_id IS NULL)
    OR (status = 'unchanged' AND same_as_snapshot_id IS NOT NULL AND check_run_id IS NOT NULL AND failure_reason IS NULL
      AND canonical_hash IS NULL AND hmac IS NULL AND seq IS NULL AND prev_hmac IS NULL))
);
CREATE INDEX IF NOT EXISTS audit_snapshots_company_taken_idx ON audit_snapshots (company_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS audit_snapshot_tb (
  snapshot_id UUID NOT NULL,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL,
  row         JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, account_id),
  CONSTRAINT audit_snapshot_tb_snapshot_fk FOREIGN KEY (company_id, snapshot_id)
    REFERENCES audit_snapshots (company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_snapshot_journals (
  snapshot_id   UUID NOT NULL,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_id    UUID NOT NULL,
  entry_date    DATE NOT NULL,
  row           JSONB NOT NULL,
  material_hash TEXT NOT NULL CHECK (material_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (snapshot_id, journal_id),
  CONSTRAINT audit_snapshot_journals_snapshot_fk FOREIGN KEY (company_id, snapshot_id)
    REFERENCES audit_snapshots (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS audit_snapshot_journals_date_idx ON audit_snapshot_journals (snapshot_id, entry_date, journal_id);

CREATE TABLE IF NOT EXISTS audit_snapshot_lines (
  snapshot_id   UUID NOT NULL,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  line_id       UUID NOT NULL,
  journal_id    UUID NOT NULL,
  row           JSONB NOT NULL,
  material_hash TEXT NOT NULL CHECK (material_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (snapshot_id, line_id),
  CONSTRAINT audit_snapshot_lines_snapshot_fk FOREIGN KEY (company_id, snapshot_id)
    REFERENCES audit_snapshots (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS audit_snapshot_lines_journal_idx ON audit_snapshot_lines (snapshot_id, journal_id);

-- ── 3. The audit pack cites the snapshot it was built from (additive) ─────
ALTER TABLE audit_trail_exports ADD COLUMN IF NOT EXISTS snapshot_id UUID;
ALTER TABLE audit_trail_exports ADD COLUMN IF NOT EXISTS zip_storage_bucket TEXT;
ALTER TABLE audit_trail_exports ADD COLUMN IF NOT EXISTS zip_storage_path TEXT;
ALTER TABLE audit_trail_exports ADD COLUMN IF NOT EXISTS zip_sha256 TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'audit_trail_exports_snapshot_fk') THEN
    ALTER TABLE audit_trail_exports ADD CONSTRAINT audit_trail_exports_snapshot_fk
      FOREIGN KEY (company_id, snapshot_id) REFERENCES audit_snapshots (company_id, id) ON DELETE CASCADE;
  END IF;
END $$;

-- A ready pack is what the auditor downloads: its snapshot and file pointers are fixed from the moment it is ready
-- (re-pointing pack B at pack A's ZIP, or at another uploaded file, by one UPDATE is refused); a row cannot be
-- INSERTed already ready (a pack becomes ready only by being built), and a ready pack is not deleted except with
-- its company. Defence in depth: the download routes verify the ZIP's sealed manifest before serving it anyway.
CREATE OR REPLACE FUNCTION public.audit_trail_export_pack_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'ready' THEN
      RAISE EXCEPTION 'audit_trail_exports: a pack is ready only once built' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ready' AND EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
      RAISE EXCEPTION 'audit_trail_exports: a ready pack is kept (removed only with its company)' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  -- Into ready: only a pack built from a snapshot (a ZIP the download routes can verify), never a bare file pointer.
  IF NEW.status = 'ready' AND OLD.status IS DISTINCT FROM 'ready' THEN
    IF NEW.snapshot_id IS NULL OR NEW.zip_storage_path IS NULL OR NEW.zip_sha256 IS NULL THEN
      RAISE EXCEPTION 'audit_trail_exports: a pack is ready only with its snapshot and ZIP' USING ERRCODE = '42501';
    END IF;
    -- When it became ready, by the database's clock: a retired key vouches only for packs built before it was retired.
    NEW.built_at := pg_catalog.now();
  END IF;
  IF OLD.status = 'ready' AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.zip_storage_bucket IS DISTINCT FROM OLD.zip_storage_bucket
      OR NEW.zip_storage_path IS DISTINCT FROM OLD.zip_storage_path OR NEW.zip_sha256 IS DISTINCT FROM OLD.zip_sha256
      OR NEW.pdf_storage_bucket IS DISTINCT FROM OLD.pdf_storage_bucket
      OR NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
      OR NEW.built_at IS DISTINCT FROM OLD.built_at) THEN
    RAISE EXCEPTION 'audit_trail_exports: a ready pack''s snapshot and files are fixed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS audit_trail_export_pack_guard ON audit_trail_exports;
CREATE TRIGGER audit_trail_export_pack_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_trail_exports
  FOR EACH ROW EXECUTE FUNCTION public.audit_trail_export_pack_guard();
ALTER TABLE audit_trail_exports ENABLE ALWAYS TRIGGER audit_trail_export_pack_guard;
REVOKE ALL ON FUNCTION public.audit_trail_export_pack_guard() FROM PUBLIC;

-- ── 4. Row-level security: owner / admin / manager of the company ────────
CREATE OR REPLACE FUNCTION public.audit_snapshot_reader(p_company_id pg_catalog.uuid)
RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_company_id = app.current_company_id()
     AND p_company_id IN (SELECT auth.user_companies())
     AND COALESCE(public.company_member_actor_role(p_company_id) IN ('owner', 'admin', 'manager'), false)
$$;

ALTER TABLE audit_check_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_check_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_check_runs_read ON audit_check_runs;
CREATE POLICY audit_check_runs_read ON audit_check_runs FOR SELECT TO app_user USING (public.audit_snapshot_reader(company_id));
ALTER TABLE audit_check_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_check_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_check_results_read ON audit_check_results;
CREATE POLICY audit_check_results_read ON audit_check_results FOR SELECT TO app_user USING (public.audit_snapshot_reader(company_id));
ALTER TABLE audit_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_snapshots_read ON audit_snapshots;
CREATE POLICY audit_snapshots_read ON audit_snapshots FOR SELECT TO app_user USING (public.audit_snapshot_reader(company_id));
ALTER TABLE audit_snapshot_tb ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_snapshot_tb FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_snapshot_tb_read ON audit_snapshot_tb;
CREATE POLICY audit_snapshot_tb_read ON audit_snapshot_tb FOR SELECT TO app_user USING (public.audit_snapshot_reader(company_id));
ALTER TABLE audit_snapshot_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_snapshot_journals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_snapshot_journals_read ON audit_snapshot_journals;
CREATE POLICY audit_snapshot_journals_read ON audit_snapshot_journals FOR SELECT TO app_user USING (public.audit_snapshot_reader(company_id));
ALTER TABLE audit_snapshot_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_snapshot_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_snapshot_lines_read ON audit_snapshot_lines;
CREATE POLICY audit_snapshot_lines_read ON audit_snapshot_lines FOR SELECT TO app_user USING (public.audit_snapshot_reader(company_id));

-- ── 5. Append-only by grant: every non-owner loses everything (default
-- privileges grant app_user / platform_admin ALL on a new table), then
-- app_user gets SELECT back. Nobody but the owner may INSERT: the writers
-- run as their owner.
DO $$
DECLARE
  v_table pg_catalog.text;
  r RECORD;
BEGIN
  FOR v_table IN SELECT x.t FROM (VALUES ('audit_check_runs'), ('audit_check_results'), ('audit_snapshots'),
      ('audit_snapshot_tb'), ('audit_snapshot_journals'), ('audit_snapshot_lines')) x(t) LOOP
    FOR r IN
      SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee) AS grantee
      FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass AND a.grantee <> c.relowner AND a.grantee <> 0
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM %I', v_table, r.grantee);
    END LOOP;
    EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM PUBLIC', v_table);
    EXECUTE pg_catalog.format('GRANT SELECT ON public.%I TO app_user', v_table);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.audit_snapshot_append_only() RETURNS trigger
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

DO $$
DECLARE v_table pg_catalog.text;
BEGIN
  FOR v_table IN SELECT x.t FROM (VALUES ('audit_check_runs'), ('audit_check_results'), ('audit_snapshots'),
      ('audit_snapshot_tb'), ('audit_snapshot_journals'), ('audit_snapshot_lines')) x(t) LOOP
    EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS %I ON public.%I', v_table || '_append_only', v_table);
    EXECUTE pg_catalog.format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW '
      'EXECUTE FUNCTION public.audit_snapshot_append_only()', v_table || '_append_only', v_table);
    EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS %I ON public.%I', v_table || '_no_truncate', v_table);
    EXECUTE pg_catalog.format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT '
      'EXECUTE FUNCTION public.audit_snapshot_append_only()', v_table || '_no_truncate', v_table);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', v_table, v_table || '_append_only');
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', v_table, v_table || '_no_truncate');
  END LOOP;
END $$;

-- ── 6. The writers ─────────────────────────────────────────────────────────
-- The caller as a request knows it: its subject, the company it is acting in
-- (and belongs to), its role there and the channel its claims came by.
CREATE OR REPLACE FUNCTION public.audit_snapshot_caller(p_company_id pg_catalog.uuid, p_taken_by pg_catalog.text,
  p_taken_at pg_catalog.text, p_roles pg_catalog.text[])
RETURNS pg_catalog.text
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid pg_catalog.text := auth.uid();
  v_session pg_catalog.text := NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb ->> 'session_id';
BEGIN
  IF v_uid IS NULL OR p_taken_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'audit snapshot: taken_by must be the request''s own user' USING ERRCODE = '42501';
  END IF;
  IF p_company_id IS NULL OR p_company_id IS DISTINCT FROM app.current_company_id()
     OR p_company_id NOT IN (SELECT auth.user_companies()) THEN
    RAISE EXCEPTION 'audit snapshot: not the request''s company' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.company_member_actor_role(p_company_id) = ANY (p_roles), false) THEN
    RAISE EXCEPTION 'audit snapshot: your role in this company may not record this' USING ERRCODE = '42501';
  END IF;
  IF p_taken_at IS NULL OR p_taken_at::pg_catalog.timestamptz IS DISTINCT FROM pg_catalog.now() THEN
    RAISE EXCEPTION 'audit snapshot: taken_at must be this transaction''s now()' USING ERRCODE = '22023';
  END IF;
  RETURN CASE
    WHEN v_session IS NULL THEN 'token'
    WHEN EXISTS (SELECT 1 FROM public.impersonation_sessions s WHERE s.session_id = v_session) THEN 'impersonation'
    ELSE 'session' END;
END
$$;

CREATE OR REPLACE FUNCTION public.audit_check_run_record(p_run pg_catalog.jsonb, p_results pg_catalog.jsonb)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company pg_catalog.uuid := (p_run ->> 'company_id')::pg_catalog.uuid;
  v_id pg_catalog.uuid := (p_run ->> 'id')::pg_catalog.uuid;
  v_channel pg_catalog.text;
BEGIN
  v_channel := public.audit_snapshot_caller(v_company, p_run ->> 'taken_by', p_run ->> 'taken_at',
    CASE WHEN p_run ->> 'purpose' = 'snapshot' THEN ARRAY['owner', 'admin', 'manager'] ELSE ARRAY['owner', 'admin'] END);
  INSERT INTO public.audit_check_runs (id, company_id, as_at, period_start, taken_at, taken_by, channel, purpose,
    canonical_hash, hmac, key_id, totals)
  VALUES (v_id, v_company, (p_run ->> 'as_at')::pg_catalog.date, (p_run ->> 'period_start')::pg_catalog.date,
    pg_catalog.now(), auth.uid(), v_channel, p_run ->> 'purpose', p_run ->> 'canonical_hash', p_run ->> 'hmac',
    p_run ->> 'key_id', COALESCE(p_run -> 'totals', '{}'::pg_catalog.jsonb));
  INSERT INTO public.audit_check_results (run_id, company_id, check_id, check_version, family, status, population,
    finding_count, findings)
  SELECT v_id, v_company, r.check_id, r.check_version, r.family, r.status, r.population, r.finding_count, r.findings
  FROM pg_catalog.jsonb_to_recordset(COALESCE(p_results, '[]'::pg_catalog.jsonb)) AS r(check_id pg_catalog.text,
    check_version pg_catalog.int4, family pg_catalog.text, status pg_catalog.text, population pg_catalog.int4,
    finding_count pg_catalog.int4, findings pg_catalog.jsonb);
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.audit_snapshot_record(p_snapshot pg_catalog.jsonb, p_tb pg_catalog.jsonb,
  p_journals pg_catalog.jsonb, p_lines pg_catalog.jsonb)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_company pg_catalog.uuid := (p_snapshot ->> 'company_id')::pg_catalog.uuid;
  v_id pg_catalog.uuid := (p_snapshot ->> 'id')::pg_catalog.uuid;
  v_status pg_catalog.text := p_snapshot ->> 'status';
  v_channel pg_catalog.text;
  v_prev_seq pg_catalog.int4;
  v_prev_hmac pg_catalog.text;
BEGIN
  v_channel := public.audit_snapshot_caller(v_company, p_snapshot ->> 'taken_by', p_snapshot ->> 'taken_at',
    CASE WHEN p_snapshot ->> 'trigger' = 'manual' THEN ARRAY['owner', 'admin'] ELSE ARRAY['owner', 'admin', 'manager'] END);
  IF v_status <> 'sealed' AND (pg_catalog.jsonb_array_length(COALESCE(p_tb, '[]')) > 0
      OR pg_catalog.jsonb_array_length(COALESCE(p_journals, '[]')) > 0 OR pg_catalog.jsonb_array_length(COALESCE(p_lines, '[]')) > 0) THEN
    RAISE EXCEPTION 'audit snapshot: a failed or unchanged attempt records no rows' USING ERRCODE = '22023';
  END IF;
  -- The chain: one numbered row per sealed snapshot, in order, each naming an earlier sealed row (or none). The app
  -- names the newest earlier row whose seal VERIFIES — the database cannot check an HMAC, so a forged row written
  -- here is skipped by the next genuine link rather than becoming its predecessor; verifyChain reports it as forged.
  IF v_status = 'sealed' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('audit_snapshot_chain:' || v_company::pg_catalog.text));
    SELECT max(s.seq) INTO v_prev_seq FROM public.audit_snapshots s WHERE s.company_id = v_company AND s.status = 'sealed';
    v_prev_hmac := p_snapshot ->> 'prev_hmac';
    IF (p_snapshot ->> 'seq')::pg_catalog.int4 IS DISTINCT FROM COALESCE(v_prev_seq, 0) + 1
       OR (v_prev_hmac IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.audit_snapshots s
             WHERE s.company_id = v_company AND s.status = 'sealed' AND s.hmac = v_prev_hmac)) THEN
      RAISE EXCEPTION 'audit snapshot: not the next link of this company''s chain (expected seq %)', COALESCE(v_prev_seq, 0) + 1
        USING ERRCODE = '40001';
    END IF;
  END IF;
  INSERT INTO public.audit_snapshots (id, company_id, cutoff, taken_at, taken_by, channel, trigger, status, failure_reason,
    canonical_hash, hmac, key_id, master_data_high_water, totals, caveat, check_run_id, seq, prev_hmac, same_as_snapshot_id)
  VALUES (v_id, v_company, (p_snapshot ->> 'cutoff')::pg_catalog.date, pg_catalog.now(), auth.uid(), v_channel,
    p_snapshot ->> 'trigger', v_status, p_snapshot ->> 'failure_reason', p_snapshot ->> 'canonical_hash',
    p_snapshot ->> 'hmac', p_snapshot ->> 'key_id', (p_snapshot ->> 'master_data_high_water')::pg_catalog.timestamptz,
    COALESCE(p_snapshot -> 'totals', '{}'::pg_catalog.jsonb), p_snapshot ->> 'caveat',
    (p_snapshot ->> 'check_run_id')::pg_catalog.uuid, (p_snapshot ->> 'seq')::pg_catalog.int4, p_snapshot ->> 'prev_hmac',
    (p_snapshot ->> 'same_as_snapshot_id')::pg_catalog.uuid);
  INSERT INTO public.audit_snapshot_tb (snapshot_id, company_id, account_id, row)
  SELECT v_id, v_company, r.account_id, r.row
  FROM pg_catalog.jsonb_to_recordset(COALESCE(p_tb, '[]')) AS r(account_id pg_catalog.uuid, row pg_catalog.jsonb);
  INSERT INTO public.audit_snapshot_journals (snapshot_id, company_id, journal_id, entry_date, row, material_hash)
  SELECT v_id, v_company, r.journal_id, r.entry_date, r.row, r.material_hash
  FROM pg_catalog.jsonb_to_recordset(COALESCE(p_journals, '[]')) AS r(journal_id pg_catalog.uuid,
    entry_date pg_catalog.date, row pg_catalog.jsonb, material_hash pg_catalog.text);
  INSERT INTO public.audit_snapshot_lines (snapshot_id, company_id, line_id, journal_id, row, material_hash)
  SELECT v_id, v_company, r.line_id, r.journal_id, r.row, r.material_hash
  FROM pg_catalog.jsonb_to_recordset(COALESCE(p_lines, '[]')) AS r(line_id pg_catalog.uuid, journal_id pg_catalog.uuid,
    row pg_catalog.jsonb, material_hash pg_catalog.text);
  RETURN v_id;
END
$$;

-- EXECUTE: the writers to app_user alone; the helpers and the guard to nobody
-- but their owner (a trigger fires without an EXECUTE check).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS fn, pg_catalog.pg_get_userbyid(a.grantee) AS grantee
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = ANY (ARRAY[
        'public.audit_snapshot_record(pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb)',
        'public.audit_check_run_record(pg_catalog.jsonb,pg_catalog.jsonb)',
        'public.audit_snapshot_caller(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text[])',
        'public.audit_snapshot_append_only()']::pg_catalog.regprocedure[]::pg_catalog.oid[])
      AND a.grantee <> p.proowner AND a.grantee <> 0
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, r.grantee);
  END LOOP;
  REVOKE ALL ON FUNCTION public.audit_snapshot_record(pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.audit_check_run_record(pg_catalog.jsonb, pg_catalog.jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.audit_snapshot_caller(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text[]) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.audit_snapshot_append_only() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.audit_snapshot_record(pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb) TO app_user;
  GRANT EXECUTE ON FUNCTION public.audit_check_run_record(pg_catalog.jsonb, pg_catalog.jsonb) TO app_user;
END $$;

-- ── 7. Assertions: refuse to ship it any other way ────────────────────────
-- The exemption is 872's (#680): only the role RUNNING this migration, when
-- it inherits the owner. Any other member of the owner still refuses it.
DO $$
DECLARE
  v_table pg_catalog.text;
  v_owner pg_catalog.oid;
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
  v_fn pg_catalog.text;
BEGIN
  FOR v_table IN SELECT x.t FROM (VALUES ('audit_check_runs'), ('audit_check_results'), ('audit_snapshots'),
      ('audit_snapshot_tb'), ('audit_snapshot_journals'), ('audit_snapshot_lines')) x(t) LOOP
    v_owner := (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass);
    FOR v_role IN
      SELECT r.rolname FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.oid <> v_owner AND r.rolname !~ '^pg_'
        AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE'))
      UNION ALL SELECT 'public'
    LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'] LOOP
        IF pg_catalog.has_table_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION 'migration 890: % still holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF pg_catalog.has_any_column_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION 'migration 890: % still holds column % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT pg_catalog.has_table_privilege('app_user', 'public.' || v_table, 'SELECT')
       OR pg_catalog.has_table_privilege('platform_admin', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'migration 890: app_user must read %, platform_admin must not', v_table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass
                   AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'migration 890: % must have forced row level security', v_table;
    END IF;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = ('public.' || v_table)::pg_catalog.regclass AND NOT t.tgisinternal AND t.tgenabled = 'A'
          AND t.tgfoid = 'public.audit_snapshot_append_only()'::pg_catalog.regprocedure) <> 2
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = ('public.' || v_table)::pg_catalog.regclass AND NOT t.tgisinternal AND t.tgenabled <> 'A') THEN
      RAISE EXCEPTION 'migration 890: % must carry its two ENABLE ALWAYS append-only guards and no disabled trigger', v_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.audit_trail_exports'::pg_catalog.regclass
                 AND t.tgname = 'audit_trail_export_pack_guard' AND t.tgenabled = 'A'
                 AND (t.tgtype::pg_catalog.int4 & 28) = 28) THEN  -- INSERT (4), DELETE (8) and UPDATE (16)
    RAISE EXCEPTION 'migration 890: audit_trail_exports must carry its ENABLE ALWAYS pack guard on INSERT, UPDATE and DELETE';
  END IF;

  -- FORCE RLS binds the writers' owner too: one without BYPASSRLS would be refused every insert.
  FOREACH v_fn IN ARRAY ARRAY[
      'public.audit_snapshot_record(pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb)',
      'public.audit_check_run_record(pg_catalog.jsonb,pg_catalog.jsonb)'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid = v_fn::pg_catalog.regprocedure AND p.prosecdef AND (r.rolbypassrls OR r.rolsuper)
    ) THEN
      RAISE EXCEPTION 'migration 890: % must be SECURITY DEFINER with an owner that bypasses RLS', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
      'public.audit_snapshot_record(pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb)',
      'public.audit_check_run_record(pg_catalog.jsonb,pg_catalog.jsonb)',
      'public.audit_snapshot_caller(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text[])',
      'public.audit_snapshot_reader(pg_catalog.uuid)', 'public.audit_snapshot_append_only()',
      'public.audit_trail_export_pack_guard()'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_fn::pg_catalog.regprocedure
        AND p.proconfig[pg_catalog.array_upper(p.proconfig, 1)] ~ '^search_path=.*pg_temp$'
    ) THEN
      RAISE EXCEPTION 'migration 890: % must pin search_path with pg_temp last', v_fn;
    END IF;
  END LOOP;
  -- Who may call what: the two writers app_user alone; the caller check and
  -- the guard nobody but their owner.
  FOREACH v_fn IN ARRAY ARRAY[
      'public.audit_snapshot_record(pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.jsonb)',
      'public.audit_check_run_record(pg_catalog.jsonb,pg_catalog.jsonb)',
      'public.audit_snapshot_caller(pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text[])',
      'public.audit_snapshot_append_only()'] LOOP
    v_owner := (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_fn::pg_catalog.regprocedure);
    FOR v_role IN
      SELECT r.rolname FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> v_owner
        AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE'))
        AND NOT (r.rolname = 'app_user' AND v_fn ~ '_record\(')
      UNION ALL SELECT 'public'
    LOOP
      IF pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 890: % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
END $$;
