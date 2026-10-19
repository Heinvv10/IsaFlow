/**
 * Statement extraction state — how a bank/supplier statement row that is being
 * read in the background (or failed to be) is presented to its readers.
 *
 * A row is 'extracting' while a job reads it, 'failed' when the job gave up. The
 * job heartbeats after each page; a row 'extracting' with no heartbeat for
 * STALE_AFTER_MINUTES (the process restarted mid-read) is reported as failed and
 * retryable, computed on read — no cron. SQL that acts on "stale" (retry, delete)
 * uses the same limit, so a row the UI shows as interrupted is one they accept.
 */

import { log } from '@/lib/logger';
import { StatementReadError } from './vlmStatementPages';

export const STALE_AFTER_MINUTES = 5;
export const STALE_ERROR = 'Extraction was interrupted — retry it.';
export const GENERIC_ERROR = 'The statement could not be read. Retry the import.';
/** The one failure a retry cannot fix: the statement is too long however often it is read. */
export const TOO_MANY_PAGES = 'too_many_pages';

/** The extraction columns of a statement row; a raw database row fits. */
export type ExtractionColumns = Partial<Record<
  'status' | 'created_at' | 'extraction_heartbeat_at' | 'extraction_error' | 'extraction_error_code'
  | 'extraction_pages_done' | 'extraction_pages_total',
  unknown
>>;

export interface ExtractionState {
  status: string;
  extractionError: string | null;
  retryable: boolean;
  pagesDone: number | null;
  pagesTotal: number | null;
}

function toMillis(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

const toIntOrNull = (value: unknown): number | null => (value == null ? null : Number(value));

/** The state a reader should show for `row`, with a stale 'extracting' row reported as failed. */
export function effectiveExtractionState(row: ExtractionColumns, now: number = Date.now()): ExtractionState {
  const pagesDone = toIntOrNull(row.extraction_pages_done);
  const pagesTotal = toIntOrNull(row.extraction_pages_total);
  const status = String(row.status);

  if (status === 'extracting') {
    const lastSign = toMillis(row.extraction_heartbeat_at ?? row.created_at);
    if (now - lastSign > STALE_AFTER_MINUTES * 60_000) {
      return { status: 'failed', extractionError: STALE_ERROR, retryable: true, pagesDone, pagesTotal };
    }
    return { status, extractionError: null, retryable: false, pagesDone, pagesTotal };
  }
  if (status === 'failed') {
    return {
      status,
      extractionError: typeof row.extraction_error === 'string' && row.extraction_error ? row.extraction_error : GENERIC_ERROR,
      retryable: row.extraction_error_code !== TOO_MANY_PAGES,
      pagesDone,
      pagesTotal,
    };
  }
  return { status, extractionError: null, retryable: false, pagesDone: null, pagesTotal: null };
}

/**
 * What to store on a row whose extraction threw. Only a read error carries a
 * message written for the user; anything else is logged and hidden behind a
 * generic one (it may name a host, a table or a path).
 */
export function describeExtractionFailure(err: unknown, kind: 'bank' | 'supplier'): { message: string; code: string } {
  if (err instanceof StatementReadError) return { message: err.message, code: err.code };
  log.error('Statement extraction failed unexpectedly', {
    kind, error: err instanceof Error ? err.message : String(err),
  }, 'statement-extraction');
  return { message: GENERIC_ERROR, code: 'unexpected' };
}

export type ExtractionActionCode = 'NOT_FOUND' | 'IN_PROGRESS' | 'NOT_RETRYABLE' | 'NOT_FAILED';

/** Retry or delete refused: thrown before any write, so a route may answer 404/409. */
export class ExtractionActionRefusedError extends Error {
  constructor(readonly code: ExtractionActionCode, message: string) {
    super(message);
    this.name = 'ExtractionActionRefusedError';
  }
}

/**
 * Why a guarded retry/delete matched no row, from the row as it is now (null
 * when there is none). Only explains: the guarded statement already decided.
 */
export function explainRefusal(action: 'retry' | 'delete', row: ExtractionColumns | null): ExtractionActionRefusedError {
  if (!row) return new ExtractionActionRefusedError('NOT_FOUND', 'Statement not found.');
  const state = effectiveExtractionState(row);
  if (state.status === 'extracting') {
    return new ExtractionActionRefusedError('IN_PROGRESS', 'This statement is still being read.');
  }
  if (action === 'retry') {
    return new ExtractionActionRefusedError('NOT_RETRYABLE', state.status === 'failed' && state.extractionError
      ? `${state.extractionError} It cannot be retried.`
      : 'Only a statement that failed to be read can be retried.');
  }
  return new ExtractionActionRefusedError('NOT_FAILED', 'Only a statement that failed to be read can be deleted here.');
}
