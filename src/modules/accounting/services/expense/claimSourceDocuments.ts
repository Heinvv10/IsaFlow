/**
 * The capture posting claim, taken by a MANUAL expense claim line (R-105).
 *
 * `post-expense` stamps `captured_documents.posted_at` before it creates its
 * claim. The manual routes (`POST /expense-claims`, `POST /expense-claims/[id]`)
 * wrote `lines[].sourceDocumentId` with no check at all, so:
 *   - a slip already posted through capture went on a manual claim too, and the
 *     same input VAT was claimed twice;
 *   - one slip could sit on two claims;
 *   - another company's `captured_documents` id was accepted, because the FK
 *     check that guards the column runs without RLS.
 *
 * `claimLineSourceDocuments` is the same `posted_at` fence the posting routes
 * use (`claimCapturedDocumentForPosting`), taken for every line in ONE
 * statement: every slip is claimed or none is. That matters because `withAuth`
 * COMMITs on a 4xx: a line-by-line claim that refused the second slip would
 * commit the first one's stamp with no claim behind it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { ClaimOutsideTransactionError } from '@/modules/accounting/services/core/documentClaimLock';
import { releaseCapturedDocumentPostingClaim } from '@/modules/accounting/services/capture/capturePostingClaimRelease';
import {
  findPostedContent,
  lockPostedContent,
  PostedContentBusyError,
} from '@/modules/accounting/services/capture/postedContentFence';
import { receiptContentKey } from '@/modules/accounting/services/capture/receiptFingerprint';
import { NOT_READ, readGateFor, STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';

export type ClaimSourceDocumentRefusal =
  'not_found' | 'already_posted' | 'on_claim' | 'rejected' | 'duplicate' | 'duplicate_file' | 'busy' | 'content_posted' | 'being_read' | 'not_read';

const MESSAGE: Record<ClaimSourceDocumentRefusal, string> = {
  not_found: 'Source document not found',
  already_posted: 'Document already posted',
  on_claim: 'Document is already on another expense claim',
  rejected: 'Document was rejected — reopen it before posting',
  duplicate: 'The same source document is on more than one line',
  duplicate_file: 'The same file was uploaded twice and is on more than one line — keep one of them',
  busy: 'A source document is being posted by another request — retry in a moment',
  content_posted: 'The same file was already posted from another upload — it cannot be booked twice',
  being_read: STILL_BEING_READ,
  not_read: NOT_READ,
};

/**
 * Some slips were stamped and not all. NOT a refusal: callers must let it reach
 * a 5xx so the request rolls the stamps back — a route catch that answers 4xx
 * for any error has to rethrow this one, because withAuth COMMITs a 4xx.
 */
export class PartialSourceDocumentClaimError extends Error {
  constructor(claimed: number, wanted: number) {
    super(`Partial source-document claim (${claimed} of ${wanted}); rolled back`);
    this.name = 'PartialSourceDocumentClaimError';
  }
}

/** `lock_not_available` (the bounded wait elapsed) and `deadlock_detected`. */
const LOCK_ERRORS = new Set(['55P03', '40P01']);

/**
 * A line's source document cannot be claimed. Thrown before anything is
 * written, so the route may answer 400 with it.
 */
export class ClaimSourceDocumentError extends Error {
  readonly code = 'CLAIM_SOURCE_DOCUMENT_REFUSED';
  constructor(readonly refusal: ClaimSourceDocumentRefusal, readonly documentId: string) {
    super(MESSAGE[refusal]);
    this.name = 'ClaimSourceDocumentError';
  }
}

/**
 * R-088: a slip whose FILE is already booked from another upload is refused,
 * as is one file uploaded twice onto two lines — each would expense the same
 * purchase twice. Called with the rows already locked, then takes the
 * fingerprints' advisory locks: the same row-then-fingerprint order as every
 * posting route (`captureRowLock` → `checkReceiptDuplicate` / the claim), so a
 * claim line and a route post of one document cannot deadlock. The locks hold
 * to commit, so a concurrent post of the same file or receipt waits for this
 * one. Returns each slip's receipt key for the UPDATE to stamp, so the
 * receipt routes can match a re-encoded copy of a slip booked here; the key is
 * locked but not checked here — a manual claim line has no confirm flow, and
 * the file check is the one this path can refuse on without a person's say.
 */
async function refuseFilesAlreadyPosted(companyId: string, ids: string[]): Promise<Map<string, string | null>> {
  const rows = (await sql`
    SELECT id, raw_bytes_sha256, extracted_data, read_state, read_heartbeat_at, created_at FROM captured_documents
     WHERE id = ANY(${ids}::uuid[]) AND company_id = ${companyId}
     ORDER BY id`) as DbRow[];
  const keys = new Map<string, string | null>();
  const byHash = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.id);
    // Only a finished read has an extraction; refused before any fingerprint lock or stamp.
    const gate = readGateFor(row);
    if (gate) throw new ClaimSourceDocumentError(gate, id);
    keys.set(id, receiptContentKey((row.extracted_data as Record<string, unknown> | null) ?? {}));
    if (!row.raw_bytes_sha256) continue;
    const hash = String(row.raw_bytes_sha256);
    if (byHash.has(hash)) throw new ClaimSourceDocumentError('duplicate_file', id);
    byHash.set(hash, id);
  }
  try {
    await lockPostedContent(companyId, [
      ...[...byHash.keys()].map((h) => `sha:${h}`),
      ...[...keys.values()].map((k) => (k ? `key:${k}` : null)),
    ]);
  } catch (err) {
    if (err instanceof PostedContentBusyError) throw new ClaimSourceDocumentError('busy', ids[0]!);
    throw err;
  }
  for (const [contentSha256, id] of byHash) {
    if (await findPostedContent(companyId, id, { contentSha256, spend: 'expense' })) {
      throw new ClaimSourceDocumentError('content_posted', id);
    }
  }
  return keys;
}

/**
 * Claim every line's source document for this company, all or nothing.
 * Lines without one are ignored. Throws `ClaimSourceDocumentError` and writes
 * nothing when any slip is missing, foreign, already claimed or rejected.
 */
export async function claimLineSourceDocuments(
  companyId: string,
  lines: ReadonlyArray<{ sourceDocumentId?: string | null }>,
): Promise<void> {
  // Canonical form (lower-case, hyphenated): Postgres accepts braces, missing
  // hyphens and upper case, and returns the canonical form, while the refusal
  // lookup and the duplicate check compare strings. A malformed id is refused
  // as not found here rather than failing the uuid cast.
  const raw = lines.map((l) => l.sourceDocumentId).filter((id): id is string => !!id);
  if (raw.length === 0) return;
  const ids = raw.map((id) => {
    const hex = id.toLowerCase().replace(/^\{|\}$/g, '').replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/.test(hex)) throw new ClaimSourceDocumentError('not_found', id);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ClaimSourceDocumentError('duplicate', duplicate);

  // The eligible set is locked, and the UPDATE applies only when it is the
  // whole set. A concurrent claimer that got there first leaves its row out
  // of `eligible` (re-checked after the lock wait), so the count falls short
  // and nothing is written. Without the lock the snapshot count could pass
  // while a concurrent claimer took one row, and only part of the set would
  // be stamped (see the partial-claim error below).
  //
  // The wait is bounded like the capture posting paths' (`captureRowLock`):
  // 5s, then a retryable refusal. A lock error aborts the transaction, so the
  // route's 4xx still commits nothing; the bound is reset once granted so it
  // does not cap later waits in the request.
  // Outside a request transaction FOR UPDATE is released at once and SET LOCAL
  // does nothing, so the claim would guard nothing: refuse to run there.
  const client = als.getStore()?.client;
  if (!client) throw new ClaimOutsideTransactionError('source document');
  await client.query("SET LOCAL lock_timeout = '5s'");
  let claimed: DbRow[];
  try {
    // Rows first, in id order, then the content fingerprints — the order every
    // posting route takes them in (R-088). The CTE below re-locks rows this
    // transaction already holds, so it does not wait.
    await sql`
      SELECT id FROM captured_documents
       WHERE id = ANY(${ids}::uuid[]) AND company_id = ${companyId}
       ORDER BY id
       FOR UPDATE`;
    const keys = await refuseFilesAlreadyPosted(companyId, ids);
    claimed = (await sql`
    WITH eligible AS (
      SELECT id FROM captured_documents
       WHERE id = ANY(${ids}::uuid[])
         AND company_id = ${companyId}
         AND posted_at IS NULL
         AND status <> 'rejected'
         AND read_state = 'done'
         -- Lines written before R-105 never stamped posted_at: a slip on a live
         -- claim line is taken whatever its posted_at says.
         AND NOT EXISTS (
           SELECT 1 FROM expense_claim_lines ecl
             JOIN expense_claims ec ON ec.id = ecl.claim_id AND ec.company_id = ecl.company_id
            WHERE ecl.source_document_id = captured_documents.id
              AND ecl.company_id = captured_documents.company_id
              AND ec.status NOT IN ('rejected', 'cancelled'))
       FOR UPDATE
    )
    UPDATE captured_documents cd
       SET posted_at = NOW(), status = 'matched', updated_at = NOW(),
           posted_content_sha256 = cd.raw_bytes_sha256,
           posted_receipt_key = (SELECT k.key FROM unnest(${ids}::uuid[], ${ids.map((id) => keys.get(id) ?? null)}::text[]) AS k(id, key)
                                  WHERE k.id = cd.id)
     WHERE cd.id IN (SELECT id FROM eligible)
       AND (SELECT COUNT(*) FROM eligible) = ${ids.length}
    RETURNING cd.id`) as DbRow[];
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && LOCK_ERRORS.has(code)) throw new ClaimSourceDocumentError('busy', ids[0]!);
    throw err;
  }
  await client.query('SET LOCAL lock_timeout = DEFAULT');
  if (claimed.length === ids.length) return;
  // Some slips stamped and not all: only possible if the lock above stopped
  // holding the set (tested by removing it). A 4xx here would COMMIT the
  // partial stamps, so this is an error the request rolls back, never a refusal.
  if (claimed.length > 0) {
    throw new PartialSourceDocumentClaimError(claimed.length, ids.length);
  }

  const rows = (await sql`
    SELECT cd.id, cd.status, cd.posted_at, cd.read_state, cd.read_heartbeat_at, cd.created_at,
           EXISTS (
             SELECT 1 FROM expense_claim_lines ecl
               JOIN expense_claims ec ON ec.id = ecl.claim_id AND ec.company_id = ecl.company_id
              WHERE ecl.source_document_id = cd.id AND ecl.company_id = cd.company_id
                AND ec.status NOT IN ('rejected', 'cancelled')) AS on_claim
      FROM captured_documents cd
     WHERE cd.id = ANY(${ids}::uuid[]) AND cd.company_id = ${companyId}`) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new ClaimSourceDocumentError('not_found', id);
    if (row.posted_at != null) throw new ClaimSourceDocumentError('already_posted', id);
    if (row.on_claim === true) throw new ClaimSourceDocumentError('on_claim', id);
    if (row.status === 'rejected') throw new ClaimSourceDocumentError('rejected', id);
    const gate = readGateFor(row);
    if (gate) throw new ClaimSourceDocumentError(gate, id);
  }
  // Every slip read as claimable a moment after the claim refused one: a
  // concurrent claim came and went. Refuse rather than guess.
  throw new ClaimSourceDocumentError('already_posted', ids[0]!);
}

/**
 * Lock the claim row, then read the source documents on its lines, for release
 * after a delete. The lock is what makes the read complete: a concurrent
 * add-line's INSERT needs a key-share lock on the claim row, so it either
 * finished before this (and its line is read here) or waits and then fails on
 * the deleted parent (and its claim rolls back with it).
 */
export async function lockClaimReadSourceDocumentIds(claimId: string, companyId: string): Promise<string[]> {
  await sql`
    SELECT id FROM expense_claims
     WHERE id = ${claimId}::uuid AND company_id = ${companyId}
     FOR UPDATE`;
  const rows = (await sql`
    SELECT DISTINCT source_document_id FROM expense_claim_lines
     WHERE claim_id = ${claimId}::uuid AND company_id = ${companyId}
       AND source_document_id IS NOT NULL`) as DbRow[];
  return rows.map((r) => String(r.source_document_id));
}

/**
 * Give back the slips of lines that no longer exist. The release only succeeds
 * when nothing live in the ledger still references the slip.
 */
export async function releaseSourceDocuments(companyId: string, documentIds: readonly string[]): Promise<void> {
  for (const id of documentIds) await releaseCapturedDocumentPostingClaim(companyId, id);
}
