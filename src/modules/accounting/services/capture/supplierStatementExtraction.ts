/**
 * Supplier statement extraction — where a stored statement's lines come from.
 *
 * A PDF is read by the VLM one page per call (bank/vlmStatementPages); there is
 * no deterministic parser for supplier layouts. An image is read in one call.
 * Runs in the background job (supplierStatementExtractionJob), outside any
 * request, so it only ever fetches the stored bytes, by company.
 */

import { fetchRawBytes } from '@/lib/documentStorage';
import { isVlmAvailable } from '@/modules/accounting/services/bank/vlmCore';
import { mergeSupplierPages } from '@/modules/accounting/services/bank/vlmStatementMerge';
import { readStatementPdf, StatementReadError } from '@/modules/accounting/services/bank/vlmStatementPages';
import {
  extractSupplierStatementImage,
  readSupplierStatementPage,
  type SupplierStatementExtraction,
} from '@/modules/accounting/services/bank/vlmSupplierStatementService';

const IMAGE_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
};

/**
 * Read the captured document's statement. Throws StatementReadError (a message
 * safe to show the user) when it cannot be read; `onProgress` reports pages read.
 */
export async function extractSupplierStatementFromDocument(
  companyId: string,
  capturedDocumentId: string,
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<SupplierStatementExtraction> {
  const raw = await fetchRawBytes(capturedDocumentId, companyId);
  if (!raw) throw new StatementReadError('unreadable', 'The uploaded file could not be found. Upload it again.');

  const mime = raw.fileType === 'pdf' ? 'application/pdf' : IMAGE_MIME[raw.fileType];
  if (!mime) throw new StatementReadError('unreadable', 'This file type cannot be read as a supplier statement.');
  if (!isVlmAvailable()) {
    throw new StatementReadError('unavailable', 'Statement reading is not available right now. Retry the import later.');
  }

  if (mime === 'application/pdf') {
    return mergeSupplierPages(await readStatementPdf(raw.buffer, 'supplier', readSupplierStatementPage, onProgress));
  }
  const image = await extractSupplierStatementImage(raw.buffer.toString('base64'), mime);
  if (!image) throw new StatementReadError('page_failed', 'The statement image could not be read. Retry the import.');
  return image;
}
