/**
 * Bank statement extraction — where a stored statement's rows come from.
 *
 * A PDF goes to the deterministic parsers (ABSA, the per-bank factory) first:
 * they read a digital statement exactly and instantly. Only a PDF they find
 * nothing in (a scan, an unknown layout) is read by the VLM, one page per call
 * (vlmStatementPages). An image is read in one call. Runs in the background job
 * (bankStatementExtractionJob), outside any request, so it only ever fetches the
 * stored bytes, by company.
 */

import { fetchRawBytes } from '@/lib/documentStorage';
import { parseBankPdf } from '@/modules/accounting/utils/bankPdfParser';
import type { BankCsvParseResult } from '@/modules/accounting/types/bank.types';
import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';
import { isVlmAvailable } from './vlmCore';
import { extractBankStatementWithVlm, readBankStatementPage } from './vlmBankService';
import { mergeBankPages } from './vlmStatementMerge';
import { readStatementPdf, StatementReadError } from './vlmStatementPages';

const IMAGE_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
};

const unavailable = () => new StatementReadError('unavailable',
  'Statement reading is not available right now. Retry the import later.');

/** The parsers' rows, in the shape the VLM path produces; the period spans the rows' dates. */
function fromParsers(parsed: BankCsvParseResult): ExtractedBankStatement {
  const dates = parsed.transactions.map((t) => t.transactionDate).filter(Boolean).sort();
  return {
    bankName: null,
    accountNumber: parsed.accountNumber ?? null,
    statementPeriod: dates.length > 0 ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    openingBalance: null,
    closingBalance: null,
    transactions: parsed.transactions.map((t) => ({
      date: t.transactionDate,
      description: t.description,
      amount: t.amount,
      balance: t.balance ?? null,
      reference: t.reference ?? null,
      transactionType: null,
    })),
    confidence: 1,
    warnings: parsed.errors.map((e) => e.error),
  };
}

/**
 * Read the captured document's statement. Throws StatementReadError (a message
 * safe to show the user) when it cannot be read; `onProgress` reports pages read.
 */
export async function extractBankStatementFromDocument(
  companyId: string,
  capturedDocumentId: string,
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<ExtractedBankStatement> {
  const raw = await fetchRawBytes(capturedDocumentId, companyId);
  if (!raw) throw new StatementReadError('unreadable', 'The uploaded file could not be found. Upload it again.');

  if (raw.fileType === 'pdf') {
    const parsed = await parseBankPdf(raw.buffer);
    if (parsed.transactions.length > 0) return fromParsers(parsed);
    if (!isVlmAvailable()) throw unavailable();
    return mergeBankPages(await readStatementPdf(raw.buffer, 'bank', readBankStatementPage, onProgress));
  }

  const mime = IMAGE_MIME[raw.fileType];
  if (!mime) throw new StatementReadError('unreadable', 'This file type cannot be read as a bank statement.');
  if (!isVlmAvailable()) throw unavailable();
  const image = await extractBankStatementWithVlm(raw.buffer.toString('base64'), mime);
  if (!image) throw new StatementReadError('page_failed', 'The statement image could not be read. Retry the import.');
  return image;
}
