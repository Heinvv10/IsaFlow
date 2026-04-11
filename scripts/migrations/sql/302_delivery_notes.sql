-- Migration 302: Delivery Notes
-- Standalone delivery note document type, linkable to Sales Orders and Invoices

CREATE TABLE IF NOT EXISTS delivery_notes (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id          UUID        NOT NULL REFERENCES customers(id),
  sales_order_id       UUID        REFERENCES customer_sales_orders(id),
  invoice_id           UUID        REFERENCES customer_invoices(id),
  delivery_note_number TEXT        NOT NULL,
  delivery_date        DATE        NOT NULL DEFAULT CURRENT_DATE,
  status               TEXT        NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','dispatched','delivered','cancelled')),
  delivery_address     TEXT,
  notes                TEXT,
  created_by           VARCHAR     REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, delivery_note_number)
);

CREATE TABLE IF NOT EXISTS delivery_note_lines (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_note_id UUID         NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  description      TEXT         NOT NULL,
  quantity         NUMERIC(15,4) NOT NULL DEFAULT 1,
  unit             TEXT,
  item_id          UUID,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_notes_company
  ON delivery_notes(company_id, delivery_date DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_note_lines_note
  ON delivery_note_lines(delivery_note_id);
