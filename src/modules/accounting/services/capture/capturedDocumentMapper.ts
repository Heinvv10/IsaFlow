/**
 * A captured_documents row as the Document Capture API returns it. Shared by
 * the list/upload route and the action route so both carry the read state.
 */

import { fmtDate } from '@/lib/fmtDate';
import type { CapturedDocument } from '../../types/documentCapture.types';
import { effectiveReadState } from './captureReadState';

/**
 * The stored extraction, or null when there is none. A row inserted for a
 * background read holds '{}' until the read finishes (and keeps it when the
 * read fails); readers treat any truthy extractedData as a full extraction.
 */
function extractedDataOf(value: unknown): CapturedDocument['extractedData'] {
  if (!value) return null;
  const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
  return Object.keys(parsed).length > 0 ? (parsed as unknown as CapturedDocument['extractedData']) : null;
}

export function mapCapturedDocumentRow(row: Record<string, unknown>, now: number = Date.now()): CapturedDocument {
  const { readState, readError } = effectiveReadState(row, now);
  return {
    id: row.id as string,
    fileName: row.file_name as string,
    fileType: row.file_type as string,
    fileSize: row.file_size as number | null,
    documentType: row.document_type as string | null,
    extractedData: extractedDataOf(row.extracted_data),
    vendorName: row.vendor_name as string | null,
    documentDate: row.document_date ? fmtDate(row.document_date) : null,
    referenceNumber: row.reference_number as string | null,
    totalAmount: row.total_amount !== null && row.total_amount !== undefined ? parseFloat(String(row.total_amount)) : null,
    vatAmount: row.vat_amount !== null && row.vat_amount !== undefined ? parseFloat(String(row.vat_amount)) : null,
    status: (row.status as CapturedDocument['status']) || 'pending',
    matchedInvoiceId: row.matched_invoice_id as string | null,
    matchedBankTxId: row.matched_bank_tx_id as string | null,
    notes: row.notes as string | null,
    uploadedBy: row.uploaded_by as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
    readState,
    readError,
  };
}
