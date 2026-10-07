-- 871: FX programme PR0 — refuse foreign-currency documents until the ledger can carry them.
-- 2026-10-07 | fix/fx-pr0-refuse-foreign-currency-20261007
--
-- The UI can create a USD customer invoice, and postCustomerInvoiceToGL posts
-- its USD figures as rands. Settlement is currency-blind too: a ZAR receipt
-- adds rands to a USD amount_paid. Until the FX programme lands functional
-- posting (PR1a), the carrying-movement ledger (PR3) and the settlement
-- writers (PR4-PR6), a foreign-currency document must not be written, posted
-- or settled. This file is the database half of that refusal; the services
-- refuse first, before any write.
--
--   1. Pre-checks, so a row the CHECKs below would reject is NAMED, not left
--      to a bare "check constraint is violated". lock_timeout bounds the
--      ACCESS EXCLUSIVE that SET NOT NULL and ADD CHECK take on companies,
--      which every request reads.
--   2. companies.functional_currency is the ONE authority for "own currency":
--      NOT NULL and CHECK = 'ZAR' (the GL, the VAT201 and fmtZAR are rand-only).
--   3. companies.fx_documents_enabled, false by default. Only a role that
--      bypasses RLS (platform_admin, the migration role) may change it
--      (fx_documents_switch_guard); app_user may not, whatever its policies.
--   4. bank_accounts.currency = 'ZAR'. The table is vestigial (a bank account
--      is a gl_accounts row, which has no currency); this only shuts the door.
--   5. public.fx_functional(amount, rate): the ONE conversion, ROUND(amount *
--      rate, 2), half away from zero. Its TypeScript twin is
--      shared/functionalAmounts.toFunctional; a parity test holds them.
--   6. fx_row_is_foreign: whether a row's currency columns name anything but
--      the company's functional currency. NULL and blank are the functional
--      currency, as shared/documentCurrency reads them.
--   7. While a company has not enabled them, no customer invoice, supplier
--      invoice or credit note may be WRITTEN in another currency, changed
--      into one, or POSTED in one — entering the posted population, or taking
--      its journal link (fx_document_currency_gate).
--   8. No amount_paid may be written on a foreign-currency invoice or bill,
--      on INSERT (importers) or UPDATE (every settlement writer)
--      (fx_settlement_refusal). Temporary: PR3 replaces the UPDATE arm with
--      the carrying-movement trigger; the INSERT arm stays (imports are ZAR).
--   9. Grants and the owner assertion.
--
-- The two document triggers are SECURITY DEFINER with pg_temp last, owned by
-- a role that bypasses RLS (712's reasons): they read companies whatever the
-- writer's row security, and a company they cannot see refuses, not passes.
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

-- ── 1. Pre-checks and the lock bound ───────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE v_rows TEXT;
BEGIN
  SELECT string_agg(id::TEXT || '=' || functional_currency, ', ') INTO v_rows
  FROM (SELECT id, functional_currency FROM companies
        WHERE functional_currency IS DISTINCT FROM 'ZAR' AND functional_currency IS NOT NULL
        ORDER BY id LIMIT 20) c;
  IF v_rows IS NOT NULL THEN
    RAISE EXCEPTION 'migration 871: companies with a functional_currency other than ZAR (first 20): %. Correct them before the CHECK.', v_rows;
  END IF;
  SELECT string_agg(id::TEXT || '=' || COALESCE(currency, 'NULL'), ', ') INTO v_rows
  FROM (SELECT id, currency FROM bank_accounts WHERE currency IS DISTINCT FROM 'ZAR' ORDER BY id LIMIT 20) b;
  IF v_rows IS NOT NULL THEN
    RAISE EXCEPTION 'migration 871: bank_accounts not in ZAR (first 20): %. Correct them before the CHECK.', v_rows;
  END IF;
END $$;

-- ── 2. The functional currency ──────────────────────────────────────────────
UPDATE companies SET functional_currency = 'ZAR' WHERE functional_currency IS NULL;
ALTER TABLE companies ALTER COLUMN functional_currency SET DEFAULT 'ZAR';
ALTER TABLE companies ALTER COLUMN functional_currency SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_functional_currency_zar') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_functional_currency_zar CHECK (functional_currency = 'ZAR');
  END IF;
END $$;

-- ── 3. The per-company switch, and who may move it ─────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fx_documents_enabled BOOLEAN NOT NULL DEFAULT false;

-- INVOKER on purpose: current_user is the writer. app_user's admin policy on
-- companies lets a tenant admin update its own row; this column is not theirs.
CREATE OR REPLACE FUNCTION public.fx_documents_switch_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RAISE EXCEPTION 'FX_SWITCH_REFUSED: only a platform administrator may change fx_documents_enabled (role %)', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_companies_fx_switch_guard_ins ON companies;
CREATE TRIGGER trg_companies_fx_switch_guard_ins
  BEFORE INSERT ON companies
  FOR EACH ROW WHEN (NEW.fx_documents_enabled)
  EXECUTE FUNCTION public.fx_documents_switch_guard();
DROP TRIGGER IF EXISTS trg_companies_fx_switch_guard_upd ON companies;
CREATE TRIGGER trg_companies_fx_switch_guard_upd
  BEFORE UPDATE OF fx_documents_enabled ON companies
  FOR EACH ROW WHEN (OLD.fx_documents_enabled IS DISTINCT FROM NEW.fx_documents_enabled)
  EXECUTE FUNCTION public.fx_documents_switch_guard();

-- ── 4. Vestigial bank_accounts ─────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_accounts_currency_zar') THEN
    ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_currency_zar CHECK (currency = 'ZAR');
  END IF;
END $$;

-- ── 5. The one conversion ──────────────────────────────────────────────────
-- Schema-qualified and with no SET clause, so it stays inlinable (PR1a uses it
-- in generated columns and aggregates). numeric round() is half away from zero.
CREATE OR REPLACE FUNCTION public.fx_functional(p_amount pg_catalog.numeric, p_rate pg_catalog.numeric)
RETURNS pg_catalog.numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT pg_catalog.round(p_amount OPERATOR(pg_catalog.*) p_rate, 2) $$;

-- ── 6. Whether a row is foreign ────────────────────────────────────────────
-- supplier_invoices carries both `currency` (211) and `currency_code` (299);
-- either one foreign makes the bill foreign. A company the function cannot
-- read answers foreign: refuse, not pass. Not itself a definer: only the two
-- definer triggers below call it, so it runs as their owner.
CREATE OR REPLACE FUNCTION public.fx_row_is_foreign(
  p_company_id pg_catalog.uuid, p_codes pg_catalog.text[]
) RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_codes) AS code
    WHERE NULLIF(pg_catalog.upper(pg_catalog.btrim(code)), '') IS NOT NULL
      AND pg_catalog.upper(pg_catalog.btrim(code)) IS DISTINCT FROM
          (SELECT c.functional_currency FROM public.companies c WHERE c.id = p_company_id)
  )
$$;

-- ── 7. The document gate ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fx_document_currency_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_codes pg_catalog.text[];
BEGIN
  IF TG_TABLE_NAME = 'customer_invoices' THEN
    v_codes := ARRAY[NEW.currency_code];
  ELSIF TG_TABLE_NAME = 'supplier_invoices' THEN
    v_codes := ARRAY[NEW.currency_code, NEW.currency];
  ELSE
    v_codes := ARRAY[NEW.currency];
  END IF;
  -- No company is the NOT NULL constraint's refusal to make, not this one's.
  IF NEW.company_id IS NULL
     OR COALESCE((SELECT c.fx_documents_enabled FROM public.companies c WHERE c.id = NEW.company_id), false) THEN
    RETURN NEW;
  END IF;
  IF public.fx_row_is_foreign(NEW.company_id, v_codes) THEN
    RAISE EXCEPTION 'FX_DOCUMENTS_DISABLED: % % is in % — foreign-currency documents are not enabled for this company',
      TG_TABLE_NAME, NEW.id, pg_catalog.array_to_string(v_codes, '/')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- UPDATE fires on a currency change, on entering the posted population
-- (documentPopulation's excluded statuses: draft, pending_approval,
-- cancelled), and on taking a journal link — every way a document posts. An
-- edit that leaves all three alone (a notes edit, a settlement status move)
-- does not fire, so a legacy foreign draft is still editable in the database;
-- the service refuses that edit with a 400 instead.
DROP TRIGGER IF EXISTS trg_customer_invoice_fx_gate ON customer_invoices;
DROP TRIGGER IF EXISTS trg_customer_invoice_fx_gate_ins ON customer_invoices;
CREATE TRIGGER trg_customer_invoice_fx_gate_ins
  BEFORE INSERT ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION public.fx_document_currency_gate();
DROP TRIGGER IF EXISTS trg_customer_invoice_fx_gate_upd ON customer_invoices;
CREATE TRIGGER trg_customer_invoice_fx_gate_upd
  BEFORE UPDATE OF currency_code, status, gl_journal_entry_id ON customer_invoices
  FOR EACH ROW WHEN (
    OLD.currency_code IS DISTINCT FROM NEW.currency_code
    OR (COALESCE(OLD.status, '') IN ('draft', 'pending_approval', 'cancelled')
        AND COALESCE(NEW.status, '') NOT IN ('draft', 'pending_approval', 'cancelled'))
    OR (OLD.gl_journal_entry_id IS NULL AND NEW.gl_journal_entry_id IS NOT NULL))
  EXECUTE FUNCTION public.fx_document_currency_gate();

DROP TRIGGER IF EXISTS trg_supplier_invoice_fx_gate ON supplier_invoices;
DROP TRIGGER IF EXISTS trg_supplier_invoice_fx_gate_ins ON supplier_invoices;
CREATE TRIGGER trg_supplier_invoice_fx_gate_ins
  BEFORE INSERT ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.fx_document_currency_gate();
DROP TRIGGER IF EXISTS trg_supplier_invoice_fx_gate_upd ON supplier_invoices;
CREATE TRIGGER trg_supplier_invoice_fx_gate_upd
  BEFORE UPDATE OF currency_code, currency, status, gl_journal_entry_id ON supplier_invoices
  FOR EACH ROW WHEN (
    OLD.currency_code IS DISTINCT FROM NEW.currency_code
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR (COALESCE(OLD.status, '') IN ('draft', 'pending_approval', 'cancelled')
        AND COALESCE(NEW.status, '') NOT IN ('draft', 'pending_approval', 'cancelled'))
    OR (OLD.gl_journal_entry_id IS NULL AND NEW.gl_journal_entry_id IS NOT NULL))
  EXECUTE FUNCTION public.fx_document_currency_gate();

DROP TRIGGER IF EXISTS trg_credit_note_fx_gate ON credit_notes;
DROP TRIGGER IF EXISTS trg_credit_note_fx_gate_ins ON credit_notes;
CREATE TRIGGER trg_credit_note_fx_gate_ins
  BEFORE INSERT ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.fx_document_currency_gate();
DROP TRIGGER IF EXISTS trg_credit_note_fx_gate_upd ON credit_notes;
CREATE TRIGGER trg_credit_note_fx_gate_upd
  BEFORE UPDATE OF currency, status, gl_journal_entry_id ON credit_notes
  FOR EACH ROW WHEN (
    OLD.currency IS DISTINCT FROM NEW.currency
    OR (COALESCE(OLD.status, '') IN ('draft', 'pending_approval', 'cancelled')
        AND COALESCE(NEW.status, '') NOT IN ('draft', 'pending_approval', 'cancelled'))
    OR (OLD.gl_journal_entry_id IS NULL AND NEW.gl_journal_entry_id IS NOT NULL))
  EXECUTE FUNCTION public.fx_document_currency_gate();

-- ── 8. The settlement refusal ──────────────────────────────────────────────
-- INSERT arm: an importer writing a non-zero amount_paid. UPDATE arm: any
-- change of amount_paid, up or down, whatever wrote it — the census of those
-- writers has been wrong five times, which is why this is a trigger.
CREATE OR REPLACE FUNCTION public.fx_settlement_refusal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_codes pg_catalog.text[];
BEGIN
  IF TG_TABLE_NAME = 'supplier_invoices' THEN
    v_codes := ARRAY[NEW.currency_code, NEW.currency];
  ELSE
    v_codes := ARRAY[NEW.currency_code];
  END IF;
  IF NEW.company_id IS NOT NULL AND public.fx_row_is_foreign(NEW.company_id, v_codes) THEN
    RAISE EXCEPTION 'FX_SETTLEMENT_REFUSED: % % is in % — settling a foreign-currency document is not supported yet',
      TG_TABLE_NAME, NEW.id, pg_catalog.array_to_string(v_codes, '/')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customer_invoice_fx_settle_ins ON customer_invoices;
CREATE TRIGGER trg_customer_invoice_fx_settle_ins
  BEFORE INSERT ON customer_invoices
  FOR EACH ROW WHEN (NEW.amount_paid IS NOT NULL AND NEW.amount_paid <> 0)
  EXECUTE FUNCTION public.fx_settlement_refusal();
DROP TRIGGER IF EXISTS trg_customer_invoice_fx_settle_upd ON customer_invoices;
CREATE TRIGGER trg_customer_invoice_fx_settle_upd
  BEFORE UPDATE OF amount_paid ON customer_invoices
  FOR EACH ROW WHEN (OLD.amount_paid IS DISTINCT FROM NEW.amount_paid)
  EXECUTE FUNCTION public.fx_settlement_refusal();
DROP TRIGGER IF EXISTS trg_supplier_invoice_fx_settle_ins ON supplier_invoices;
CREATE TRIGGER trg_supplier_invoice_fx_settle_ins
  BEFORE INSERT ON supplier_invoices
  FOR EACH ROW WHEN (NEW.amount_paid IS NOT NULL AND NEW.amount_paid <> 0)
  EXECUTE FUNCTION public.fx_settlement_refusal();
DROP TRIGGER IF EXISTS trg_supplier_invoice_fx_settle_upd ON supplier_invoices;
CREATE TRIGGER trg_supplier_invoice_fx_settle_upd
  BEFORE UPDATE OF amount_paid ON supplier_invoices
  FOR EACH ROW WHEN (OLD.amount_paid IS DISTINCT FROM NEW.amount_paid)
  EXECUTE FUNCTION public.fx_settlement_refusal();

-- ── 9. Grants and the owner assertion ──────────────────────────────────────
REVOKE ALL ON FUNCTION public.fx_row_is_foreign(pg_catalog.uuid, pg_catalog.text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_document_currency_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_settlement_refusal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_documents_switch_guard() FROM PUBLIC;

-- The definer functions read companies under whatever row security the writer
-- has; their owner must bypass it, or a company invisible to the writer would
-- read as foreign and refuse every document (716 / 862 / 865 / 867 convention).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid IN ('public.fx_document_currency_gate()'::pg_catalog.regprocedure,
                    'public.fx_settlement_refusal()'::pg_catalog.regprocedure)
      AND NOT (r.rolbypassrls OR r.rolsuper)
  ) THEN
    RAISE EXCEPTION 'migration 871: the owner of the FX gate functions must bypass RLS';
  END IF;
END $$;
