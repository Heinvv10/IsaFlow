-- Migration 463: Add document_category + resolution columns to capture pipeline
--
-- Enables the dual-post-path feature: captured documents can now be routed as
-- either 'invoice' (existing path) or 'expense' (new expense-claim / direct-GL path).
-- Resolution columns track which supplier / employee / GL account / cost centre
-- was resolved at post time.

ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS document_category TEXT
    CHECK (document_category IN ('invoice', 'expense'));

ALTER TABLE capture_events
  ADD COLUMN IF NOT EXISTS document_category TEXT
    CHECK (document_category IN ('invoice', 'expense')),
  ADD COLUMN IF NOT EXISTS resolved_supplier_id UUID,
  ADD COLUMN IF NOT EXISTS resolved_employee_id UUID,
  ADD COLUMN IF NOT EXISTS resolved_gl_account_id UUID,
  ADD COLUMN IF NOT EXISTS resolved_cost_centre_id UUID;

-- FK: resolved_supplier_id → suppliers(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_ce_resolved_supplier'
      AND table_name = 'capture_events'
  ) THEN
    ALTER TABLE capture_events
      ADD CONSTRAINT fk_ce_resolved_supplier
      FOREIGN KEY (resolved_supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- FK: resolved_employee_id → employees(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_ce_resolved_employee'
      AND table_name = 'capture_events'
  ) THEN
    ALTER TABLE capture_events
      ADD CONSTRAINT fk_ce_resolved_employee
      FOREIGN KEY (resolved_employee_id) REFERENCES payroll_employees(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- FK: resolved_gl_account_id → gl_accounts(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_ce_resolved_gl_account'
      AND table_name = 'capture_events'
  ) THEN
    ALTER TABLE capture_events
      ADD CONSTRAINT fk_ce_resolved_gl_account
      FOREIGN KEY (resolved_gl_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- FK: resolved_cost_centre_id → cost_centres(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_ce_resolved_cost_centre'
      AND table_name = 'capture_events'
  ) THEN
    ALTER TABLE capture_events
      ADD CONSTRAINT fk_ce_resolved_cost_centre
      FOREIGN KEY (resolved_cost_centre_id) REFERENCES cost_centres(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_capture_events_category ON capture_events(document_category)
  WHERE document_category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capture_events_employee ON capture_events(resolved_employee_id)
  WHERE resolved_employee_id IS NOT NULL;
