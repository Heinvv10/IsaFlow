/**
 * Capture Router Service
 * Orchestrates VLM extraction for a capture event.
 * Does NOT call the AI pipeline — that runs when the user clicks "Post".
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchRawBytes } from '@/lib/documentStorage';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/core/ocrService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Category detection — classifies a receipt/slip as 'expense' vs 'invoice'
// ---------------------------------------------------------------------------

/**
 * Heuristically decide whether an extracted document is a retail expense
 * receipt (till slip, fuel, food, transport) or a formal supplier invoice.
 *
 * Rules (evaluated in order — first match wins):
 *  1. Strong invoice signals: has both an invoice/reference number AND either
 *     a vendor VAT number or more than one line item → invoice.
 *  2. Merchant pattern hit on known SA fuel/food/travel/retail names → expense.
 *  3. Till-slip proxy: no reference number, no vendor VAT number, but has a
 *     vendor name → expense.
 *  4. Fallback → invoice (keep existing behaviour for unknown docs).
 */
export function detectDocumentCategory(extracted: ExtractedDocument): 'invoice' | 'expense' {
  const hasRef = Boolean(extracted.referenceNumber);
  const hasVat = Boolean(extracted.vendorVatNumber);
  const lineCount = extracted.lineItems?.length ?? 0;

  // Strong invoice signals
  if (hasRef && (hasVat || lineCount > 1)) {
    return 'invoice';
  }

  // Merchant pattern match → expense
  if (extracted.vendorName) {
    const name = extracted.vendorName.toLowerCase();
    if (
      /engen|shell|caltex|sasol|bp |total |fuel|petrol|diesel|spur|nandos|steers|mcdonald|kfc|wimpy|ocean basket|mugg.*bean|restaurant|cafe|coffee|uber|bolt|taxify|airport|hotel|lodge|airbnb/i.test(name)
    ) {
      return 'expense';
    }
  }

  // Till-slip proxy: no reference, no VAT number, but has vendor name
  if (!hasRef && !hasVat && extracted.vendorName) {
    return 'expense';
  }

  return 'invoice';
}

const MIME_TO_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
};

function fileTypeToMime(fileType: string): string {
  return MIME_TO_EXT[fileType.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * VLM/OCR extraction for the given mime type.
 * Fetches raw bytes from captured_documents.raw_bytes, routes to the PDF or
 * image extractor, returns null only when bytes are missing or the mime type
 * isn't supported.
 */
async function resolveExtraction(
  documentId: string,
  companyId: string,
  mimeType: string,
  captureEventId: string,
): Promise<ExtractedDocument | null> {
  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');

  if (!isPdf && !isImage) {
    log.warn('routeEvent: unsupported mime type, skipping extraction', {
      captureEventId, mimeType,
    }, 'capture-router');
    return null;
  }

  const raw = await fetchRawBytes(documentId, companyId);
  if (!raw) {
    log.warn('routeEvent: no raw bytes on captured document', {
      captureEventId, documentId,
    }, 'capture-router');
    return null;
  }

  if (isPdf) return extractFromPdf(raw.buffer);
  return extractFromImage(raw.buffer, mimeType);
}

/**
 * Orchestrate extraction for a capture event.
 * Fetches the event + captured_document, calls the OCR/VLM pipeline,
 * and updates both rows with the result.
 *
 * Status flow: received → extracting → extracted | failed
 */
export async function routeEvent(captureEventId: string, companyId: string): Promise<void> {
  // Load event + document
  const eventRows = await sql`
    SELECT ce.id AS event_id, ce.captured_document_id, ce.status AS event_status,
           cd.file_type, cd.notes AS doc_notes, cd.status AS doc_status
    FROM capture_events ce
    JOIN captured_documents cd ON cd.id = ce.captured_document_id
    WHERE ce.id = ${captureEventId}::uuid
      AND ce.company_id = ${companyId}
      AND cd.company_id = ${companyId}
    LIMIT 1
  ` as Row[];

  if (eventRows.length === 0) {
    log.warn('routeEvent: event not found', { captureEventId, companyId }, 'capture-router');
    return;
  }

  const event = eventRows[0]!;
  const documentId = event.captured_document_id as string;
  const fileType = event.file_type as string;

  // Mark as extracting
  await sql`
    UPDATE capture_events
    SET status = 'extracting', updated_at = NOW()
    WHERE id = ${captureEventId}::uuid AND company_id = ${companyId}
  `;

  try {
    const mimeType = fileTypeToMime(fileType);

    const extracted: ExtractedDocument | null = await resolveExtraction(
      documentId, companyId, mimeType, captureEventId,
    );

    if (extracted !== null) {
      const extractedData = JSON.stringify(extracted);
      const docType: string | null = extracted.documentType ?? null;
      const vendorName: string | null = extracted.vendorName ?? null;
      const docDate: string | null = extracted.date ?? null;
      const refNum: string | null = extracted.referenceNumber ?? null;
      const totalAmt: number | null = extracted.totalAmount ?? null;
      const vatAmt: number | null = extracted.vatAmount ?? null;
      const category = detectDocumentCategory(extracted);

      await sql`
        UPDATE captured_documents
        SET extracted_data     = ${extractedData}::jsonb,
            document_type      = ${docType},
            vendor_name        = ${vendorName},
            document_date      = ${docDate}::date,
            reference_number   = ${refNum},
            total_amount       = ${totalAmt},
            vat_amount         = ${vatAmt},
            document_category  = ${category},
            status             = 'pending',
            updated_at         = NOW()
        WHERE id = ${documentId}::uuid AND company_id = ${companyId}
      `;

      await sql`
        UPDATE capture_events
        SET status            = 'extracted',
            document_category = ${category},
            updated_at        = NOW()
        WHERE id = ${captureEventId}::uuid AND company_id = ${companyId}
      `;
    } else {
      await sql`
        UPDATE capture_events
        SET status = 'extracted', updated_at = NOW()
        WHERE id = ${captureEventId}::uuid AND company_id = ${companyId}
      `;
    }

    log.info('routeEvent: extraction complete', { captureEventId, hasExtracted: !!extracted }, 'capture-router');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('routeEvent: extraction failed', { captureEventId, error: msg }, 'capture-router');

    await sql`
      UPDATE capture_events
      SET status = 'failed', error = ${msg}, updated_at = NOW()
      WHERE id = ${captureEventId}::uuid AND company_id = ${companyId}
    `;
  }
}

// Export ocrService functions so unit tests can stub the extraction path
export { extractFromPdf, extractFromImage };
