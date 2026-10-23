/**
 * Capture read state — how an uploaded capture document that is read in the
 * background (or failed to be) is presented to its readers and guarded.
 *
 * A row is 'reading' while a job extracts it, 'failed' when the job threw. The
 * job heartbeats while it waits; a row 'reading' with no sign of life for
 * STALE_AFTER_MINUTES (the process restarted mid-read) is reported as failed,
 * computed on read — no cron, as for statements (statementExtractionState).
 * The upload is stored (documentStorage), so a failed or interrupted read can be
 * retried (`retryable`): the retry re-arms the row with a new `read_attempt` and
 * a second job reads the stored file. A row with no stored file, or whose file
 * the job found missing (NOT_STORED_ERROR), can only be uploaded again.
 *
 * Rows from every other inserter carry the column default 'done', and a row
 * that carries no read columns at all (an old query, a test double) is a
 * finished one.
 */

export const STALE_AFTER_MINUTES = 5;
export const STALE_READ_ERROR = 'The read was interrupted — retry it.';
/** Recorded when the job finds no bytes behind the row; a row carrying it is not retryable. */
export const NOT_STORED_ERROR = 'The file is not stored — upload it again.';
/** What a reader sees INSTEAD of the two retry messages below when the row cannot be retried (see `effectiveReadState`). */
export const UPLOAD_AGAIN_ERROR = 'The document could not be read — upload it again.';
export const UPLOAD_AGAIN_STALE_ERROR = 'The read was interrupted — upload the document again.';
export const GENERIC_READ_ERROR = 'The document could not be read — retry the read.';
/** What a route answers (409) when asked to act on a document that is still being read. */
export const STILL_BEING_READ = 'This document is still being read.';

/** What a writer that needs the extraction answers (409 / 400) for a document whose read has not finished well. */
export const NOT_READ = "This document's read did not finish — retry the read or upload the document again.";

export type ReadState = 'reading' | 'done' | 'failed';

/** The read columns of a captured_documents row; a raw database row fits. */
export type ReadColumns = Partial<
  Record<'read_state' | 'read_error' | 'read_heartbeat_at' | 'created_at' | 'storage_path' | 'posted_at' | 'status', unknown>
>;

export interface EffectiveReadState {
  readState: ReadState;
  readError: string | null;
  /** A retry is allowed: the read failed, its file is stored, and nobody has settled the document meanwhile. */
  retryable: boolean;
}

function toMillis(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

function isStale(row: ReadColumns, now: number): boolean {
  const lastSign = toMillis(row.read_heartbeat_at ?? row.created_at);
  return now - lastSign > STALE_AFTER_MINUTES * 60_000;
}

/** Whether a failed read can be re-run: stored file (not found missing), still pending, not posted. */
function canRetry(row: ReadColumns, readError: string | null): boolean {
  return typeof row.storage_path === 'string' && row.storage_path !== ''
    && row.status === 'pending' && (row.posted_at === null || row.posted_at === undefined)
    && readError !== NOT_STORED_ERROR;
}

/**
 * The wording follows `retryable`: GENERIC_READ_ERROR and STALE_READ_ERROR tell the user to retry, so a row that cannot
 * be retried shows their upload-again counterparts instead. Any other recorded reason is shown as it is.
 */
function shownError(recorded: string, retryable: boolean): string {
  if (retryable) return recorded;
  if (recorded === GENERIC_READ_ERROR) return UPLOAD_AGAIN_ERROR;
  return recorded === STALE_READ_ERROR ? UPLOAD_AGAIN_STALE_ERROR : recorded;
}

function failedState(row: ReadColumns, recorded: string): EffectiveReadState {
  const retryable = canRetry(row, recorded);
  return { readState: 'failed', readError: shownError(recorded, retryable), retryable };
}

/** The state a reader should show for `row`, with a stale 'reading' row reported as failed. */
export function effectiveReadState(row: ReadColumns, now: number = Date.now()): EffectiveReadState {
  if (row.read_state === 'reading') {
    return isStale(row, now) ? failedState(row, STALE_READ_ERROR) : { readState: 'reading', readError: null, retryable: false };
  }
  if (row.read_state === 'failed') {
    const recorded = typeof row.read_error === 'string' && row.read_error ? row.read_error : GENERIC_READ_ERROR;
    return failedState(row, recorded);
  }
  return { readState: 'done', readError: null, retryable: false };
}

/** A job is reading this document right now: 'reading' and not stale. */
export function isBeingRead(row: ReadColumns, now: number = Date.now()): boolean {
  return row.read_state === 'reading' && !isStale(row, now);
}

/**
 * May a writer that needs the extraction (posting claim, expense claim line, journal source or link) take this
 * document? null when the read finished ('done', or no read columns at all); otherwise why not: 'being_read' for a
 * fresh read, 'not_read' for a failed one or one gone silent (shown as interrupted — upload again).
 */
export function readGateFor(row: ReadColumns, now: number = Date.now()): 'being_read' | 'not_read' | null {
  const { readState } = effectiveReadState(row, now);
  if (readState === 'done') return null;
  return readState === 'reading' ? 'being_read' : 'not_read';
}

/** The message a refusal from `readGateFor` carries. */
export const READ_GATE_MESSAGE = { being_read: STILL_BEING_READ, not_read: NOT_READ } as const;
