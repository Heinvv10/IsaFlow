-- Document Capture table for OCR / Receipt capture module
CREATE TABLE IF NOT EXISTS captured_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL, -- 'pdf', 'image'
  file_size INTEGER,
  document_type TEXT, -- 'invoice', 'credit_note', 'receipt', 'statement'
  extracted_data JSONB DEFAULT '{}',
  vendor_name TEXT,
  document_date DATE,
  reference_number TEXT,
  total_amount NUMERIC(15,2),
  vat_amount NUMERIC(15,2),
  status TEXT DEFAULT 'pending', -- pending, reviewed, matched, rejected
  matched_invoice_id UUID,
  matched_bank_tx_id UUID,
  notes TEXT,
  uploaded_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_captured_documents_status ON captured_documents(status);
CREATE INDEX IF NOT EXISTS idx_captured_documents_vendor ON captured_documents(vendor_name);
CREATE INDEX IF NOT EXISTS idx_captured_documents_date ON captured_documents(document_date);
CREATE INDEX IF NOT EXISTS idx_captured_documents_created ON captured_documents(created_at DESC);
