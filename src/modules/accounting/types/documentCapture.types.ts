/**
 * Document Capture / OCR Types
 * Types for receipt and invoice extraction
 */

export interface ExtractedLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
  vatAmount: number | null;
  vatClassification: 'standard' | 'zero_rated' | 'exempt' | 'capital' | null;
  glAccountSuggestion: string | null;
}

export interface ExtractedDocument {
  documentType: 'invoice' | 'credit_note' | 'receipt' | 'statement' | 'purchase_order' | 'delivery_note' | 'unknown';
  vendorName: string | null;
  vendorVatNumber: string | null;
  vendorAddress: string | null;
  vendorBankDetails: VendorBankDetails | null;
  customerName: string | null;
  customerVatNumber: string | null;
  date: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  paymentTerms: string | null;
  referenceNumber: string | null;
  purchaseOrderRef: string | null;
  currency: string | null; // ISO 4217 e.g. "ZAR"
  subtotal: number | null;
  vatAmount: number | null;
  vatRate: number | null; // e.g. 15
  totalAmount: number | null;
  lineItems: ExtractedLineItem[];
  rawText: string;
  confidence: number; // 0-1
  warnings: string[];
  extractionMethod: 'vlm' | 'regex' | 'vlm+regex';
}

export interface VendorBankDetails {
  bankName: string | null;
  accountNumber: string | null;
  branchCode: string | null;
  accountType: string | null;
}

export interface CapturedDocument {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  documentType: string | null;
  extractedData: ExtractedDocument | null;
  vendorName: string | null;
  documentDate: string | null;
  referenceNumber: string | null;
  totalAmount: number | null;
  vatAmount: number | null;
  status: 'pending' | 'reviewed' | 'matched' | 'rejected';
  matchedInvoiceId: string | null;
  matchedBankTxId: string | null;
  notes: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

export type CapturedDocumentAction = 'confirm' | 'match_bank_tx' | 'reject';

// ---------------------------------------------------------------------------
// Bank Statement VLM extraction
// ---------------------------------------------------------------------------

export interface ExtractedBankTransaction {
  date: string | null;
  description: string;
  amount: number;
  balance: number | null;
  reference: string | null;
  transactionType: string | null;
}

export interface ExtractedBankStatement {
  bankName: string | null;
  accountNumber: string | null;
  statementPeriod: { from: string | null; to: string | null } | null;
  openingBalance: number | null;
  closingBalance: number | null;
  transactions: ExtractedBankTransaction[];
  confidence: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Statutory Document VLM extraction
// ---------------------------------------------------------------------------

export type StatutoryDocType = 'cipc' | 'tax_clearance' | 'bbee' | 'vat_registration' | 'unknown';

export interface ExtractedStatutoryDoc {
  documentType: StatutoryDocType;
  entityName: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  taxNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  bbeeLevel: number | null;
  bbeeScore: number | null;
  verificationAgency: string | null;
  confidence: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Document Validation
// ---------------------------------------------------------------------------

export interface ValidationDiscrepancy {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface DocumentValidationResult {
  valid: boolean;
  score: number; // 0-1
  discrepancies: ValidationDiscrepancy[];
  validatedAt: string;
}

// ---------------------------------------------------------------------------
// Compliance Alerts
// ---------------------------------------------------------------------------

export interface ComplianceAlert {
  documentType: StatutoryDocType;
  documentName: string;
  status: 'valid' | 'expiring_soon' | 'expiring_warning' | 'expired' | 'missing';
  expiryDate: string | null;
  daysUntilExpiry: number | null;
  message: string;
}
