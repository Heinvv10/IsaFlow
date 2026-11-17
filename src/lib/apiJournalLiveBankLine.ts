/**
 * The route answer to `JournalHasLiveBankLineError` (bank/liveBankLineReversal, 2026-11-16): a journal a live bank line
 * still books, reached by a GL reversal from any route that can call reverseJournalEntry — Journal Entries, soft delete,
 * the migration wizard's opening-balance re-run, invoice / credit-note / supplier-invoice cancel, supplier payment void.
 * Raised before any write (the claim released), so a 400 commits nothing. An expected refusal: logged at warn, never as
 * a fault, and never the opaque 500 withErrorHandler would make of it.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { isJournalHasLiveBankLine } from '@/modules/accounting/services/bank/liveBankLineReversal';

export function respondIfJournalHasLiveBankLine(res: NextApiResponse, err: unknown): boolean {
  if (!isJournalHasLiveBankLine(err)) return false;
  log.warn('Journal reversal refused: a live bank line books it', { bankTransactionId: err.bankTransactionId }, 'accounting-api');
  apiResponse.badRequest(res, err.message, { code: err.code });
  return true;
}
