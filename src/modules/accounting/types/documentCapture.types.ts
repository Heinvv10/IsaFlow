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
