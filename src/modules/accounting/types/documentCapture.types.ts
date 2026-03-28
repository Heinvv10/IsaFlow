/**
 * Document Capture / OCR Types
 * Types for receipt and invoice extraction
 */

export interface ExtractedLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
}

export interface ExtractedDocument {
  documentType: 'invoice' | 'credit_note' | 'receipt' | 'statement' | 'unknown';
  vendorName: string | null;
  vendorVatNumber: string | null;
  date: string | null; // YYYY-MM-DD
  referenceNumber: string | null;
  subtotal: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  lineItems: ExtractedLineItem[];
  rawText: string;
  confidence: number; // 0-1
  warnings: string[];
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
