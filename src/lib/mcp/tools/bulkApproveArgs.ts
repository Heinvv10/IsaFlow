/**
 * The REQUEST-shape half of the bulk approve tools: what the caller sent, and
 * the refusals that are about the request rather than about the books.
 *
 * Split from `bulkApproveRunner.ts` at the boundary that matters — nothing here
 * touches the database or writes anything, so these are the rules that can be
 * decided before a connection is opened, and they are exercised as pure
 * functions. The runner keeps everything that reads state or posts.
 */

import { UUID_RE } from '@/lib/validation';
import { MAX_POSTED_DOCUMENTS_PER_REQUEST } from '@/lib/limits/authorityHoldLimits';
import type { SkippedDocument } from './bulkApproveRunner';

/**
 * More documents than this in one call is refused; the caller splits the batch.
 *
 * The whole batch runs in one request transaction that holds the company
 * authority key, and every other request in the company waits for it. The
 * ceiling keeps that hold under half the key's 5 s bound, from measured
 * per-document holds (src/lib/limits/authorityHoldLimits.ts).
 */
export const MAX_DOCUMENTS = MAX_POSTED_DOCUMENTS_PER_REQUEST;

/**
 * The refusal for a batch where nothing is postable.
 *
 * Deliberately not a success with `posted: 0`: an agent reading that would
 * believe the work was done. Pre-write, so a `toolError` is the right shape —
 * nothing to unwind, and the registry audits it with a NULL key, leaving the
 * key usable once the agent has fixed its list.
 */
export function nothingToApproveText(skipped: readonly SkippedDocument[]): string {
  const reasons = [...new Set(skipped.map((s) => s.reason))].slice(0, 5);
  return `No document in this batch can be approved (${skipped.length} skipped: `
    + `${reasons.join('; ')}). Nothing was posted.`;
}

/**
 * Ids from the caller's array, or the refusal text.
 *
 * A REPEATED id is refused rather than skipped, which is the opposite of the
 * bulk CREATE rule and deliberately so. There, a repeat is one bill sent twice
 * and the second is redundant. Here, all elements share one transaction, so a
 * repeat's second read already sees the first's committed 'approved' status —
 * it would be silently reported as a skipped duplicate, and an agent whose list
 * accidentally contains the same invoice twice would never learn that its list
 * was wrong. The list is the agent's own; a duplicate in it is a request fault.
 */
export function parseDocumentIds(raw: unknown, field: string, max: number = MAX_DOCUMENTS): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return `${field} must be a non-empty array`;
  }
  if (raw.length > max) {
    return `${field} has ${raw.length} elements; the maximum is ${max}. `
      + 'Split it across several calls.';
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    // Shape-checked here, not left to the database. Every read below casts
    // ::UUID, and a non-uuid string raises 22P02 from inside the query — which
    // reaches the agent as GENERIC_FAILURE naming no element, after the batch
    // has already been refused for a reason it cannot see.
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      return `${field}[${i}] must be a document id (UUID)`;
    }
    if (seen.has(value)) {
      return `${field}[${i}] repeats an earlier id (${value}). `
        + 'Each document may appear once; remove the duplicate and retry.';
    }
    seen.add(value);
    ids.push(value);
  }
  return ids;
}
