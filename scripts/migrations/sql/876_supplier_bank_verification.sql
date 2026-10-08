-- 876: Supplier bank-detail verification (forensic-controls rebuild, step 1;
-- Hein's decisions 2026-10-08).
--
-- With the `supplier_bank_details` switch on (approval_enforcement, opt-in per
-- company, default off), a supplier's bank details are VERIFIED iff the
-- latest row here carries the fingerprint of its current bank columns —
-- derived, never stored as a flag (R-035's "derive, don't store"). Any change
-- to bank name, account number, branch code, account type or account holder,
-- by any writer (the UI route, MCP update_supplier, the take-on, raw SQL),
-- moves the fingerprint and so unverifies the supplier. eft-generate and
-- netcash/submit refuse a batch paying an unverified supplier
-- (ap/supplierBankVerification.ts); nothing that RECORDS money is gated.
--
--   1. supplier_bank_fingerprint(): the ONE normalisation (app code reads it
--      through SQL, never re-implements it) and supplier_bank_details_present().
--   2. supplier_bank_verifications: append-only evidence — who, when, how
--      (method + note), and for a sole-approver self-verification the roster
--      it was allowed on. Kinds: `baseline` (written by switching on, for every
--      supplier with details, by the switcher), `verified`, `self_verified`.
--   3. What the table refuses, whoever writes (memory: a control table must
--      refuse rows the code never writes): RLS binds the tenant AND the actor
--      (verified_by = the request's JWT subject); a BEFORE INSERT guard binds
--      the fingerprint to the supplier's CURRENT details, refuses a setter's
--      plain `verified`, a `baseline` outside the switch-on transaction, and
--      any row while the switch is off; verified_at is the transaction time.
--      app_user holds SELECT and INSERT only, and a trigger refuses UPDATE,
--      DELETE and TRUNCATE for every role — except the FK cascade when the
--      supplier itself is purged. Boundary: an app_user session can set its
--      own claims, so this stops bugs and mis-wired paths, not an attacker who
--      already runs arbitrary SQL as app_user. Who may verify (rank, the
--      sole-approver exception, a human session) is judged in TypeScript, on
--      the R-035 rank ladder that lives there.
--   4. supplier_bank_verified(company, supplier).
--   5. approval_enforcement accepts 'supplier_bank_details'.

-- ── 1. The fingerprint ────────────────────────────────────────────────────
-- Names (bank, type, holder): trimmed, inner whitespace collapsed, lower-case.
-- Account and branch: digits only ("62-000 000 001" is 62000000001). An empty
-- result is NULL, so '' and NULL are the same absence. A JSON array keeps the
-- columns apart (no separator a value could contain) and NULL distinct.
CREATE OR REPLACE FUNCTION public.supplier_bank_fingerprint(
  p_bank_name pg_catalog.text, p_account_number pg_catalog.text, p_branch_code pg_catalog.text,
  p_account_type pg_catalog.text, p_account_holder pg_catalog.text
) RETURNS pg_catalog.text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    NULLIF(pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(p_bank_name), '\s+', ' ', 'g')), ''),
    NULLIF(pg_catalog.regexp_replace(p_account_number, '[^0-9]', '', 'g'), ''),
    NULLIF(pg_catalog.regexp_replace(p_branch_code, '[^0-9]', '', 'g'), ''),
    NULLIF(pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(p_account_type), '\s+', ' ', 'g')), ''),
    NULLIF(pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(p_account_holder), '\s+', ' ', 'g')), '')
  )::pg_catalog.text, 'UTF8')), 'hex')
$$;

-- Details present: any column survives normalisation (the fingerprint of five
-- absences is the "no details" fingerprint).
CREATE OR REPLACE FUNCTION public.supplier_bank_details_present(
  p_bank_name pg_catalog.text, p_account_number pg_catalog.text, p_branch_code pg_catalog.text,
  p_account_type pg_catalog.text, p_account_holder pg_catalog.text
) RETURNS pg_catalog.bool
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.supplier_bank_fingerprint(p_bank_name, p_account_number, p_branch_code, p_account_type, p_account_holder)
         IS DISTINCT FROM public.supplier_bank_fingerprint(NULL, NULL, NULL, NULL, NULL)
$$;

-- ── 2. The evidence ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_bank_verifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order: "latest" must not depend on a clock or a random id.
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  company_id      UUID NOT NULL REFERENCES companies(id),
  supplier_id     UUID NOT NULL,
  fingerprint     TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  kind            TEXT NOT NULL CHECK (kind IN ('baseline', 'verified', 'self_verified')),
  method          TEXT CHECK (method IN ('phone_known_number', 'bank_confirmation_letter', 'in_person', 'other')),
  note            TEXT CHECK (note IS NULL OR (pg_catalog.char_length(pg_catalog.btrim(note)) BETWEEN 1 AND 500)),
  -- users.id is character varying(255), not uuid.
  verified_by     TEXT NOT NULL,
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  roster_snapshot JSONB,
  -- Company-scoped: a row can only name a supplier of its own company. The
  -- cascade is the one delete the table allows (the soft-delete purge).
  CONSTRAINT supplier_bank_verifications_supplier_fk FOREIGN KEY (supplier_id, company_id)
    REFERENCES suppliers(id, company_id) ON DELETE CASCADE,
  -- A person's verification states how and why; the switch-on baseline does not.
  CONSTRAINT supplier_bank_verifications_evidence_ck CHECK (
    (kind = 'baseline' AND method IS NULL AND note IS NULL)
    OR (kind <> 'baseline' AND method IS NOT NULL AND note IS NOT NULL)),
  CONSTRAINT supplier_bank_verifications_roster_ck CHECK ((kind = 'self_verified') = (roster_snapshot IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS supplier_bank_verifications_latest_idx
  ON supplier_bank_verifications (company_id, supplier_id, seq DESC);

ALTER TABLE supplier_bank_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_bank_verifications FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'supplier_bank_verifications' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON supplier_bank_verifications
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id() AND verified_by = auth.uid());
  END IF;
END $$;

-- Append-only by grant: whatever default privileges handed out, every
-- non-owner role loses everything, then app_user gets SELECT and INSERT back.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'supplier_bank_verifications'
      AND grantee <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                      WHERE c.oid = 'public.supplier_bank_verifications'::pg_catalog.regclass)
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON public.supplier_bank_verifications FROM %I', r.grantee);
  END LOOP;
END $$;
REVOKE ALL ON supplier_bank_verifications FROM PUBLIC;
GRANT SELECT, INSERT ON supplier_bank_verifications TO app_user;

-- ── 3. What the table refuses ─────────────────────────────────────────────
-- SECURITY INVOKER: it reads the supplier and the switch as the writer sees
-- them (app_user: its own tenant only; the FK has already scoped the supplier).
CREATE OR REPLACE FUNCTION public.supplier_bank_verification_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s RECORD;
BEGIN
  NEW.verified_at := pg_catalog.now();
  SELECT public.supplier_bank_fingerprint(x.bank_name, x.bank_account_number, x.bank_branch_code,
                                          x.bank_account_type, x.bank_account_holder) AS fingerprint,
         COALESCE(x.bank_details_setters::pg_catalog.text[], '{}') AS setters
    INTO s
    FROM public.suppliers x
   WHERE x.id = NEW.supplier_id AND x.company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_bank_verifications: supplier % not found in company %', NEW.supplier_id, NEW.company_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.fingerprint IS DISTINCT FROM s.fingerprint THEN
    RAISE EXCEPTION 'supplier_bank_verifications: the fingerprint is not the supplier''s current bank details'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'baseline' THEN
    -- Only the switch-on writes a baseline: the enforcement row its own
    -- transaction inserted, by the same person.
    IF NOT EXISTS (
      SELECT 1 FROM public.approval_enforcement ae
      WHERE ae.company_id = NEW.company_id AND ae.document_type = 'supplier_bank_details'
        AND ae.enabled_by = NEW.verified_by AND ae.enabled_at = pg_catalog.now()
    ) THEN
      RAISE EXCEPTION 'supplier_bank_verifications: a baseline is written only by switching the control on'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_enforcement ae
    WHERE ae.company_id = NEW.company_id AND ae.document_type = 'supplier_bank_details'
  ) THEN
    RAISE EXCEPTION 'supplier_bank_verifications: supplier bank verification is not enforced for this company'
      USING ERRCODE = '23514';
  END IF;
  -- A setter of the current details verifies only as the sole approver,
  -- recorded as such (the roster CHECK demands its snapshot).
  IF NEW.kind = 'verified' AND NEW.verified_by = ANY (s.setters) THEN
    RAISE EXCEPTION 'supplier_bank_verifications: % set these bank details and cannot verify them', NEW.verified_by
      USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'self_verified' AND NOT (NEW.verified_by = ANY (s.setters)) THEN
    RAISE EXCEPTION 'supplier_bank_verifications: self_verified is only for a setter of the details'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS supplier_bank_verification_guard ON supplier_bank_verifications;
CREATE TRIGGER supplier_bank_verification_guard
  BEFORE INSERT ON supplier_bank_verifications
  FOR EACH ROW EXECUTE FUNCTION public.supplier_bank_verification_guard();

-- Append-only for every role, the owner included. The one exception is the
-- FK cascade from a purged supplier: by then the supplier row is gone.
CREATE OR REPLACE FUNCTION public.supplier_bank_verification_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Nested, not AND: a TRUNCATE has no OLD row to read.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.suppliers x WHERE x.id = OLD.supplier_id AND x.company_id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'supplier_bank_verifications is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS supplier_bank_verification_append_only ON supplier_bank_verifications;
CREATE TRIGGER supplier_bank_verification_append_only
  BEFORE UPDATE OR DELETE ON supplier_bank_verifications
  FOR EACH ROW EXECUTE FUNCTION public.supplier_bank_verification_append_only();

DROP TRIGGER IF EXISTS supplier_bank_verification_no_truncate ON supplier_bank_verifications;
CREATE TRIGGER supplier_bank_verification_no_truncate
  BEFORE TRUNCATE ON supplier_bank_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_bank_verification_append_only();

-- ── 4. Verified, derived ──────────────────────────────────────────────────
-- STABLE, SECURITY INVOKER: as app_user it sees its own tenant only, so
-- another company's supplier is simply not verified. False with no row.
CREATE OR REPLACE FUNCTION public.supplier_bank_verified(p_company_id pg_catalog.uuid, p_supplier_id pg_catalog.uuid)
RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT v.fingerprint = public.supplier_bank_fingerprint(s.bank_name, s.bank_account_number, s.bank_branch_code,
                                                            s.bank_account_type, s.bank_account_holder)
    FROM public.suppliers s
    JOIN LATERAL (
      SELECT x.fingerprint FROM public.supplier_bank_verifications x
      WHERE x.company_id = s.company_id AND x.supplier_id = s.id
      ORDER BY x.seq DESC LIMIT 1
    ) v ON true
    WHERE s.company_id = p_company_id AND s.id = p_supplier_id
  ), false)
$$;

-- ── 5. The switch ─────────────────────────────────────────────────────────
-- 869's list verbatim, plus the new type. It governs no approval_rules row:
-- who may verify follows the supplier-payment rules.
ALTER TABLE approval_enforcement DROP CONSTRAINT IF EXISTS approval_enforcement_document_type_check;
ALTER TABLE approval_enforcement ADD CONSTRAINT approval_enforcement_document_type_check CHECK (document_type IN (
  'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note',
  'customer_credit_note', 'supplier_credit_note', 'supplier_payment', 'payment_batch', 'manual_journal',
  'supplier_bank_details'));
