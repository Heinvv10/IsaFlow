/**
 * Capture read job — reads an uploaded document in the background and moves
 * its captured_documents row out of read_state 'reading'.
 *
 * Started by the document-capture POST through runAfterCommit, so it runs after
 * the upload's COMMIT, outside any request, as the pool role with no row-level
 * security: EVERY statement here names the company, and every write is guarded
 * by `read_state = 'reading'`, so a row that was reset, deleted or already
 * finished is never overwritten by a late result.
 *
 * The save is ONE UPDATE, no transaction and no FOR UPDATE (outside a request
 * every `sql` autocommits). The UPDATE's own row lock waits for the posting and
 * lifecycle routes, which hold the row for their whole request, and re-checks
 * the WHERE afterwards. It writes only a row that is still fresh and untouched:
 * `status = 'pending'` (not rejected, confirmed or matched by a person) and
 * `posted_at IS NULL`, and a sign of life inside STALE_AFTER_MINUTES. A scalar
 * column a person already filled wins over the read value (COALESCE(column, read)).
 *
 * When the save matches nothing, ONE more guarded UPDATE ends 'reading' and
 * touches no user data and not extracted_data (so the posted-content fence still
 * holds): a row that went stale ends 'failed' ("interrupted — upload again"),
 * which is what readers already showed for it, so a late result never lands on a
 * row the user was told to re-upload; any other (rejected, confirmed, posted)
 * ends 'done'.
 *
 * The job reads the upload from Storage (the POST stored it before answering), so
 * a failed or interrupted read can be retried: the retry bumps `read_attempt` and
 * starts a second job. EVERY write here is fenced on the attempt the job was
 * started for, so a read thought dead (stale) that finishes or fails late cannot
 * touch the row its retry is reading (the bank statement job's fence). A row with
 * no stored bytes, whose object is gone, or whose bytes do not match the recorded
 * sha256 ends 'failed' with NOT_STORED_ERROR, which is not retryable.
 *
 * Never throws: a failure is recorded on the row (a user-safe message) and the
 * row ends 'failed'. A job that dies outright leaves the row 'reading' with no
 * heartbeat, which readers report as interrupted (captureReadState); that is
 * retryable too.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withKeepAlive, KEEPALIVE_INTERVAL_MS, type KeepAliveLabel } from '../bank/extractionKeepAlive';
import { GENERIC_READ_ERROR, NOT_STORED_ERROR, STALE_AFTER_MINUTES, STALE_READ_ERROR } from './captureReadState';
import { fetchRawBytes, sha256 } from '@/lib/documentStorage';
import { CapturedDocumentMissingError } from '@/lib/supabaseStorage';
import { MIME_BY_FILE_TYPE, readUploadedDocument } from './captureUploadForm';
import type { ExtractedDocument } from '../../types/documentCapture.types';

type DbRow = Record<string, unknown>;

/** The longest a read may keep its row alive; past it the row goes stale and is shown as interrupted. */
export const CAPTURE_READ_CEILING_MS = 15 * 60_000;

const KEEPALIVE_LABEL: KeepAliveLabel = { subject: 'Capture read', component: 'capture-read' };

/** The one date shape the `date` column takes; anything else the read produced (a model can say anything) is not saved there. */
function validIsoDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

/** A sign of life with no progress to report: the job is alive and waiting for a VLM slot. */
async function touch(companyId: string, documentId: string, attempt: number): Promise<void> {
  await sql`
    UPDATE captured_documents
    SET read_heartbeat_at = NOW()
    WHERE id = ${documentId}::uuid AND company_id = ${companyId} AND read_state = 'reading'
      AND read_attempt = ${attempt}
  `;
}

async function save(companyId: string, documentId: string, attempt: number, extracted: ExtractedDocument): Promise<DbRow[]> {
  return (await sql`
    UPDATE captured_documents
    SET extracted_data = ${JSON.stringify(extracted)}::jsonb,
        document_type = COALESCE(document_type, ${extracted.documentType}::text),
        vendor_name = COALESCE(vendor_name, ${extracted.vendorName}::text),
        document_date = COALESCE(document_date, ${validIsoDate(extracted.date)}::date),
        reference_number = COALESCE(reference_number, ${extracted.referenceNumber}::text),
        total_amount = COALESCE(total_amount, ${extracted.totalAmount}::numeric),
        vat_amount = COALESCE(vat_amount, ${extracted.vatAmount}::numeric),
        read_state = 'done', read_error = NULL, read_heartbeat_at = NOW()
    WHERE id = ${documentId}::uuid AND company_id = ${companyId} AND read_state = 'reading'
      AND read_attempt = ${attempt} AND posted_at IS NULL AND status = 'pending'
      AND COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})
    RETURNING id
  `) as DbRow[];
}

/**
 * The save matched nothing: the row was settled by a person, went stale, or was re-armed by a retry (then this ends
 * nothing: the attempt fence matches no row). End "reading" and touch nothing else.
 * Which of the two is decided inside the statement, from the same sign-of-life clock the save used.
 */
async function finishWithoutSaving(companyId: string, documentId: string, attempt: number): Promise<void> {
  const ended = (await sql`
    UPDATE captured_documents
    SET read_state = CASE WHEN COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})
                          THEN 'done' ELSE 'failed' END,
        read_error = CASE WHEN COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})
                          THEN NULL ELSE ${STALE_READ_ERROR} END,
        read_heartbeat_at = NOW()
    WHERE id = ${documentId}::uuid AND company_id = ${companyId} AND read_state = 'reading'
      AND read_attempt = ${attempt}
    RETURNING id, read_state
  `) as DbRow[];
  if (ended.length === 0) {
    log.warn('captureRead: document is no longer reading, nothing to finish', { documentId }, 'capture-read');
    return;
  }
  const stale = ended[0]!.read_state === 'failed';
  log.warn(stale
    ? 'captureRead: document went stale before the read finished, result dropped'
    : 'captureRead: document was settled meanwhile, result dropped', { documentId }, 'capture-read');
}

/** The bytes behind the row are not there: no pointer, or the object is gone. Retrying cannot help. */
class NotStoredError extends Error {}

async function markFailed(companyId: string, documentId: string, attempt: number, err: unknown): Promise<void> {
  log.error('captureRead: read failed', {
    documentId, error: err instanceof Error ? err.message : String(err),
  }, 'capture-read');
  const message = err instanceof NotStoredError ? NOT_STORED_ERROR : GENERIC_READ_ERROR;
  const failed = (await sql`
    UPDATE captured_documents
    SET read_state = 'failed', read_error = ${message}, read_heartbeat_at = NOW()
    WHERE id = ${documentId}::uuid AND company_id = ${companyId} AND read_state = 'reading'
      AND read_attempt = ${attempt}
    RETURNING id
  `) as DbRow[];
  log.info('captureRead: read failure recorded', { documentId, recorded: failed.length === 1 }, 'capture-read');
}

/** Load the stored upload and read it with the VLM. A Storage outage throws as it is (retryable). */
async function loadAndRead(companyId: string, documentId: string): Promise<ExtractedDocument> {
  let stored: Awaited<ReturnType<typeof fetchRawBytes>>;
  try {
    stored = await fetchRawBytes(documentId, companyId);
  } catch (err) {
    if (err instanceof CapturedDocumentMissingError) throw new NotStoredError(err.message);
    throw err;
  }
  if (!stored) throw new NotStoredError('no stored bytes behind the row');
  // Verify against the recorded COLUMN: fetchRawBytes fabricates `hash` from the bytes when the column is null (legacy rows).
  if (stored.storedHash && sha256(stored.buffer) !== stored.storedHash) {
    log.error('captureRead: stored file failed its integrity check', { documentId }, 'capture-read');
    throw new NotStoredError('the stored bytes do not match their recorded hash');
  }
  return readUploadedDocument(stored.buffer, MIME_BY_FILE_TYPE[stored.fileType] ?? 'application/octet-stream');
}

/** Read the stored upload behind `documentId` for `attempt` and finish its row. See the file header. */
export async function runCaptureRead(companyId: string, documentId: string, attempt: number): Promise<void> {
  try {
    try {
      const extracted = await withKeepAlive(
        () => touch(companyId, documentId, attempt),
        () => loadAndRead(companyId, documentId),
        KEEPALIVE_INTERVAL_MS,
        CAPTURE_READ_CEILING_MS,
        KEEPALIVE_LABEL,
      );
      const saved = await save(companyId, documentId, attempt, extracted);
      if (saved.length === 0) {
        await finishWithoutSaving(companyId, documentId, attempt);
        return;
      }
      log.info('captureRead: read complete', {
        documentId, attempt, confidence: extracted.confidence, documentType: extracted.documentType,
        extractionMethod: extracted.extractionMethod,
      }, 'capture-read');
    } catch (err) {
      await markFailed(companyId, documentId, attempt, err);
    }
  } catch (err) {
    log.error('captureRead: could not record the read outcome', {
      documentId, error: err instanceof Error ? err.message : String(err),
    }, 'capture-read');
  }
}
