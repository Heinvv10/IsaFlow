-- 245: Company Settings — Sage feature parity
-- Adds lockdown date, VAT system, entity info, regional settings, customer/supplier/item toggles,
-- document numbers, statement/document messages, branding, and extended company details.

-- ── Extended columns on companies table ──────────────────────────────────────

-- Lockdown
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lockdown_enabled BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lockdown_date DATE;

-- VAT system
ALTER TABLE companies ADD COLUMN IF NOT EXISTS vat_system_type TEXT DEFAULT 'invoice'; -- invoice, payment, none

-- Entity & statutory
ALTER TABLE companies ADD COLUMN IF NOT EXISTS entity_type TEXT DEFAULT 'company'; -- company, cc, sole_proprietor, trust, partnership, npc, other
ALTER TABLE companies ADD COLUMN IF NOT EXISTS registered_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_office TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fax TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS mobile TEXT;

-- Separate physical address (existing address columns become postal)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS physical_address_line1 TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS physical_address_line2 TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS physical_city TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS physical_province TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS physical_postal_code TEXT;

-- Tax practitioner
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_practitioner_reg_number TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_practitioner_name TEXT;

-- SARS contact
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sars_contact_first_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sars_contact_last_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sars_contact_capacity TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sars_contact_number TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sars_contact_telephone TEXT;

-- Branding
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_position TEXT DEFAULT 'top-left'; -- top-left, top-center, top-right
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_on_emails BOOLEAN DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_on_portal BOOLEAN DEFAULT true;

-- Regional settings
ALTER TABLE companies ADD COLUMN IF NOT EXISTS rounding_type TEXT DEFAULT 'none'; -- none, up, down, nearest
ALTER TABLE companies ADD COLUMN IF NOT EXISTS round_to_nearest NUMERIC DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qty_decimal_places INTEGER DEFAULT 2;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS value_decimal_places INTEGER DEFAULT 2;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS hours_decimal_places INTEGER DEFAULT 2;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cost_price_decimal_places INTEGER DEFAULT 2;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS selling_price_decimal_places INTEGER DEFAULT 2;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS currency_symbol TEXT DEFAULT 'R';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS date_format TEXT DEFAULT 'dd/mm/yyyy';

-- Email toggles
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_use_for_communication BOOLEAN DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_always_cc BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_use_service_from BOOLEAN DEFAULT false;

-- Customer & Supplier settings
ALTER TABLE companies ADD COLUMN IF NOT EXISTS warn_duplicate_customer_ref BOOLEAN DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS warn_duplicate_supplier_inv BOOLEAN DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS display_inactive_customers_processing BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS display_inactive_suppliers_processing BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS display_inactive_customers_reports BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS display_inactive_suppliers_reports BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS use_inclusive_processing BOOLEAN DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS use_account_default_line_type BOOLEAN DEFAULT false;

-- Item settings
ALTER TABLE companies ADD COLUMN IF NOT EXISTS warn_item_qty_below_zero BOOLEAN DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS block_item_qty_below_zero BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS warn_item_cost_zero BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS warn_item_selling_below_cost BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS display_inactive_items_processing BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS display_inactive_items_reports BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_orders_reserve_qty BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS display_inactive_bundles BOOLEAN DEFAULT false;

-- Outstanding balances / ageing
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ageing_monthly BOOLEAN DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ageing_based_on TEXT DEFAULT 'invoice_date'; -- invoice_date, due_date

-- ── Document Numbers ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_document_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL, -- quotation, sales_order, customer_invoice, credit_note, customer_receipt, customer_write_off, recurring_invoice, customer_adjustment, purchase_order, supplier_invoice, supplier_return, supplier_payment, supplier_adjustment, delivery_note
  prefix TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1,
  padding INTEGER NOT NULL DEFAULT 7, -- zero-pad width e.g. 7 => 0000001
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, document_type)
);

-- Default document number prefixes (inserted on company creation via service)

-- ── Statement & Document Messages ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL,
  -- Statement messages: statement_current, statement_30, statement_60, statement_90, statement_120
  -- Customer doc messages: msg_customer_quote, msg_customer_so, msg_customer_invoice, msg_customer_credit_note, msg_customer_receipt, msg_customer_write_off, msg_customer_bad_debt_relief, msg_customer_bad_debt_recovered
  -- Supplier doc messages: msg_supplier_po, msg_supplier_invoice, msg_supplier_return, msg_supplier_payment, msg_supplier_output_tax_adj, msg_supplier_input_tax_adj
  message TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, message_type)
);
