-- PRD-06 Phase 3: Dispute Workflow
--
-- One row per customer dispute (raised from the portal, internally by a user,
-- or captured from an inbound email). A dispute always targets an invoice;
-- customer_invoice_line_id is NULL for whole-invoice disputes.
--
-- Status lifecycle:  open → resolved | withdrawn | rejected
-- Re-raising after a resolve creates a *new* row — the old row stays as
-- historical evidence. Only one 'open' dispute per (invoice, line) is
-- allowed; partial unique indexes enforce this.
--
-- AR aging queries subtract SUM(disputed_amount) WHERE status='open' from the
-- overdue bucket and surface it as a separate "disputed" column. Resolving
-- with credit triggers a credit_notes row via the dispute service.

CREATE TABLE IF NOT EXISTS customer_invoice_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_invoice_id UUID NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  customer_invoice_line_id UUID REFERENCES customer_invoice_items(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  raised_by TEXT NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','withdrawn','rejected')),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  resolution_note TEXT,
  resolution_mode TEXT
    CHECK (resolution_mode IS NULL
           OR resolution_mode IN ('resolve_with_credit','resolve_no_credit','rejected','withdrawn')),
  credit_note_id UUID,
  disputed_amount NUMERIC(18,2) NOT NULL CHECK (disputed_amount > 0),
  source_document_id UUID REFERENCES captured_documents(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cust_inv_disputes_company
  ON customer_invoice_disputes(company_id, status, raised_at DESC);

CREATE INDEX IF NOT EXISTS idx_cust_inv_disputes_invoice
  ON customer_invoice_disputes(customer_invoice_id, status);

CREATE INDEX IF NOT EXISTS idx_cust_inv_disputes_line
  ON customer_invoice_disputes(customer_invoice_line_id)
  WHERE customer_invoice_line_id IS NOT NULL;

-- Only one OPEN whole-invoice dispute per invoice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_inv_disputes_whole_open
  ON customer_invoice_disputes(customer_invoice_id)
  WHERE customer_invoice_line_id IS NULL AND status = 'open';

-- Only one OPEN dispute per invoice line.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_inv_disputes_line_open
  ON customer_invoice_disputes(customer_invoice_id, customer_invoice_line_id)
  WHERE customer_invoice_line_id IS NOT NULL AND status = 'open';

DROP TRIGGER IF EXISTS update_customer_invoice_disputes_updated_at
  ON customer_invoice_disputes;
CREATE TRIGGER update_customer_invoice_disputes_updated_at
  BEFORE UPDATE ON customer_invoice_disputes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE customer_invoice_disputes IS
  'PRD-06 Phase 3 — customer disputes raised via portal, internal UI, or inbound capture.';
COMMENT ON COLUMN customer_invoice_disputes.raised_by IS
  'Origin principal: customer:<sessionHash> | user:<userId> | email:<fromAddress>';
COMMENT ON COLUMN customer_invoice_disputes.customer_invoice_line_id IS
  'NULL = whole-invoice dispute; non-null = line-level dispute.';
COMMENT ON COLUMN customer_invoice_disputes.resolution_mode IS
  'resolve_with_credit → credit_note_id populated | resolve_no_credit → re-ages | rejected | withdrawn';
COMMENT ON COLUMN customer_invoice_disputes.credit_note_id IS
  'credit_notes.id when resolution_mode=resolve_with_credit (no FK — keeps mig order flexible).';

GRANT SELECT, INSERT, UPDATE ON customer_invoice_disputes TO app_user;
