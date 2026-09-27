/**
 * The posted-CONTENT fence (R-088): has another document in this company
 * already been booked with the same file, or — for receipts — the same slip?
 *
 * Every upload is a new `captured_documents` row, so the per-document fences
 * (row lock, `posted_at` claim) never see a second upload of one slip. This is
 * the question they cannot ask, shared by the posting claim
 * (`claimCapturedDocumentForPosting`, `claimLineSourceDocuments`) and the
 * receipt routes' fuller check (`receiptDuplicateGuard.ts`).
 *
 * WHAT A POSTING SPENDS. The claim stamps `posted_content_sha256` from the
 * row's own `raw_bytes_sha256` for every caller except the provisional
 * evidence attach, which books nothing new: it hangs the slip on a journal that
 * already expensed the bank line. The slip is booked all the same, so an
 * evidenced document counts against EVERY later posting of the same content —
 * expense routes and invoice routes alike (one slip, one booking). The invoice
 * routes used to be let through, on the promise that R-127 settles the invoice
 * against the provisional; but R-127 settles only an invoice whose OWN document
 * evidences the provisional, so an invoice raised from a SECOND upload of the
 * slip was approved beside it and booked the bill twice. The legitimate R-127
 * flow never reaches this check for another document: the invoice route claims
 * its own slip first, and the evidence attach follows on that same document.
 * `spend` therefore only decides the stamp (`capturePostingClaim.ts`), not
 * which earlier postings count.
 *
 * SERIALISED, NOT JUST READ. Two uploads are two rows, so their row locks do
 * not order two concurrent posts; each would read "nothing posted" and post.
 * `lockPostedContent` takes a transaction-scoped advisory lock per
 * fingerprint, in sorted order so two keys cannot deadlock, under the same
 * bounded 5s wait as the capture row locks. The second request waits for the
 * first to commit, then reads its posting and refuses.
 */

import { als, assertTxUsable } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { referencesDistinguish } from './receiptFingerprint';

/** What a posting does with the slip. Decides the stamp only — see the header. */
export type ContentSpend = 'expense' | 'invoice' | 'evidence';

/** `lock_not_available` (the 5s `lock_timeout` elapsed) and `deadlock_detected`. */
const LOCK_ERRORS = new Set(['55P03', '40P01']);

/** Another request holds the fingerprint past the bounded wait. Nothing has been written. */
export class PostedContentBusyError extends Error {
  readonly code = 'RECEIPT_POST_BUSY';
  constructor() {
    super('Another request is posting a document with the same content — retry in a moment.');
    this.name = 'PostedContentBusyError';
  }
}

/** The advisory-lock name of one fingerprint (`sha:<hash>` or `key:<receipt key>`), company-scoped. */
export const contentLockKey = (companyId: string, key: string): string => `r088|${companyId}|${key}`;

export async function lockPostedContent(companyId: string, keys: ReadonlyArray<string | null>): Promise<void> {
  const sorted = [...new Set(keys.filter((k): k is string => !!k))].sort();
  if (sorted.length === 0) return;
  // Outside a request transaction the xact lock is released with the statement;
  // there is no transaction to bound, so no SET LOCAL either.
  const client = als.getStore()?.client;
  if (client) {
    assertTxUsable();
    await client.query("SET LOCAL lock_timeout = '5s'");
  }
  try {
    for (const key of sorted) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${contentLockKey(companyId, key)}, 0))`;
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && LOCK_ERRORS.has(code)) throw new PostedContentBusyError();
    throw err;
  }
  // Reset once granted, or the bound caps every later lock wait in the request.
  if (client) await client.query('SET LOCAL lock_timeout = DEFAULT');
}

export interface PostedContentMatch {
  id: string;
  fileName: string;
  postedAt: unknown;
  /** Same bytes: the same slip, full stop. False means a receipt-key match. */
  sameFile: boolean;
}

export interface PostedContentQuery {
  contentSha256: string | null;
  spend: ContentSpend;
  /** Receipts only: the normalised vendor|date|total|VAT key, and the printed number that can tell two apart. */
  receiptKey?: string | null;
  referenceNumber?: unknown;
}

/**
 * The earliest OTHER document in the company, currently posted, with the same
 * bytes or the same receipt key — a same-file match preferred over a key
 * match. A key match does not count when both sides printed a reference
 * number and they differ. Call under `lockPostedContent` for an answer that
 * holds until commit.
 */
export async function findPostedContent(
  companyId: string,
  documentId: string,
  q: PostedContentQuery,
): Promise<PostedContentMatch | null> {
  const receiptKey = q.receiptKey ?? null;
  if (!q.contentSha256 && !receiptKey) return null;
  const rows = (await sql`
    SELECT cd.id, cd.file_name, cd.posted_at, cd.extracted_data->>'referenceNumber' AS reference,
           (cd.raw_bytes_sha256 IS NOT NULL AND cd.raw_bytes_sha256 = ${q.contentSha256}) IS TRUE AS same_file
      FROM captured_documents cd
     WHERE cd.company_id = ${companyId}
       AND cd.id <> ${documentId}::uuid
       AND cd.posted_at IS NOT NULL
       AND ((${q.contentSha256}::text IS NOT NULL AND cd.raw_bytes_sha256 = ${q.contentSha256})
         OR (${receiptKey}::text IS NOT NULL AND cd.posted_receipt_key = ${receiptKey}))
     ORDER BY cd.posted_at, cd.id`) as DbRow[];
  const hit = rows.find((r) => r.same_file === true)
    ?? rows.find((r) => !referencesDistinguish(r.reference, q.referenceNumber));
  return hit
    ? { id: String(hit.id), fileName: String(hit.file_name), postedAt: hit.posted_at, sameFile: hit.same_file === true }
    : null;
}
