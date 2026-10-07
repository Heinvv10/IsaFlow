-- 871: FX programme PR0 — refuse foreign-currency documents until the ledger can carry them.
-- 2026-10-07 | fix/fx-pr0-refuse-foreign-currency-20261007
--
-- The UI can create a USD customer invoice today, and postCustomerInvoiceToGL
-- posts its USD figures as rands. Settlement is currency-blind too: a ZAR
-- receipt adds rands to a USD amount_paid. Until the FX programme lands
-- functional posting (PR1a), the carrying-movement ledger (PR3) and the
-- settlement writers (PR4-PR6), a foreign-currency document must not exist,
-- and one that does must not be settled. This file is the database half of
-- that refusal; the services refuse first, before any write.
--
--   1. companies.functional_currency is the ONE authority for "own currency".
--      NOT NULL and CHECK = 'ZAR': the GL, the VAT201 and fmtZAR are rand-only
--      throughout. default_currency stays a form default and nothing more.
--   2. companies.fx_documents_enabled, false by default. While false, no
--      customer invoice, supplier invoice or credit note may be written in a
--      currency other than the functional one (fx_document_currency_gate).
--      Switched on per company only after PR4 (AR) / PR5 (AP) are live.
--   3. No amount_paid may be written on a foreign-currency invoice or bill,
--      on INSERT (importers) or UPDATE (every settlement writer)
--      (fx_settlement_refusal). Temporary: PR3 replaces the UPDATE arm with
--      the carrying-movement trigger; the INSERT arm stays (imports are ZAR).
--   4. bank_accounts.currency = 'ZAR'. The table is vestigial (a bank account
--      is a gl_accounts row, which carries no currency), so this only closes
--      the door if it is ever revived.
--   5. public.fx_functional(amount, rate): the ONE conversion, ROUND(amount *
--      rate, 2), half away from zero. Its TypeScript twin is
--      shared/functionalAmounts.toFunctional; a parity test holds them together.
--
-- Both trigger functions are SECURITY DEFINER with pg_temp last, owned by a
-- role that bypasses RLS (712's reasons): they read companies whatever the
-- writer's row security, and a company they cannot see refuses, not passes.
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

-- ── 1. The functional currency ──────────────────────────────────────────────
UPDATE companies SET functional_currency = 'ZAR' WHERE functional_currency IS NULL;
ALTER TABLE companies ALTER COLUMN functional_currency SET DEFAULT 'ZAR';
ALTER TABLE companies ALTER COLUMN functional_currency SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_functional_currency_zar') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_functional_currency_zar CHECK (functional_currency = 'ZAR');
  END IF;
END $$;

-- ── 2. The per-company switch ──────────────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fx_documents_enabled BOOLEAN NOT NULL DEFAULT false;

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

-- ── 2/3. Which currencies a row carries, and whether any is foreign ────────
-- supplier_invoices carries both `currency` (211) and `currency_code` (299);
-- either one foreign makes the bill foreign. NULL is the functional currency
-- (299's default; every reader treats it so). A company the function cannot
-- read answers NULL, which both callers treat as foreign: refuse, not pass.
-- Not itself a definer: only the two definer triggers below call it, so it
-- runs as their owner; PUBLIC may not call it.
CREATE OR REPLACE FUNCTION public.fx_row_is_foreign(
  p_company_id pg_catalog.uuid, p_codes pg_catalog.text[]
) RETURNS pg_catalog.bool
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_codes) AS code
    WHERE code IS NOT NULL
      AND pg_catalog.upper(pg_catalog.btrim(code)) IS DISTINCT FROM
          (SELECT c.functional_currency FROM public.companies c WHERE c.id = p_company_id)
  )
$$;

-- ── 2. The document gate ───────────────────────────────────────────────────
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
  IF COALESCE((SELECT c.fx_documents_enabled FROM public.companies c WHERE c.id = NEW.company_id), false) THEN
    RETURN NEW;
  END IF;
  IF public.fx_row_is_foreign(NEW.company_id, v_codes) THEN
    RAISE EXCEPTION 'FX_DOCUMENTS_DISABLED: % % is in % — foreign-currency documents are not enabled for this company',
      TG_TABLE_NAME, NEW.id, pg_catalog.array_to_string(v_codes, '/')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customer_invoice_fx_gate ON customer_invoices;
CREATE TRIGGER trg_customer_invoice_fx_gate
  BEFORE INSERT OR UPDATE OF currency_code ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION public.fx_document_currency_gate();
DROP TRIGGER IF EXISTS trg_supplier_invoice_fx_gate ON supplier_invoices;
CREATE TRIGGER trg_supplier_invoice_fx_gate
  BEFORE INSERT OR UPDATE OF currency_code, currency ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.fx_document_currency_gate();
DROP TRIGGER IF EXISTS trg_credit_note_fx_gate ON credit_notes;
CREATE TRIGGER trg_credit_note_fx_gate
  BEFORE INSERT OR UPDATE OF currency ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.fx_document_currency_gate();

-- ── 3. The settlement refusal ──────────────────────────────────────────────
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
  IF public.fx_row_is_foreign(NEW.company_id, v_codes) THEN
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

REVOKE ALL ON FUNCTION public.fx_row_is_foreign(pg_catalog.uuid, pg_catalog.text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_document_currency_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_settlement_refusal() FROM PUBLIC;

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
