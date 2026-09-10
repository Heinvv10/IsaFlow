/**
 * May a capture LIFECYCLE button (confirm / reject) act on this document?
 *
 * Its own module because the route may not hold both halves of the answer: the
 * gate takes the document lock, consults the posting claim, and hands back a
 * claim that nothing live in the ledger is standing behind. The route is left
 * with the two things it owns — the lifecycle UPDATE and the wording of the
 * refusal.
 */

import { releaseUnpostedCaptureClaim } from './capturePostingClaimRelease';
import { lockCapturedDocumentForUpdate } from './captureRowLock';

/** Whether a lifecycle button may proceed, once the claim has been consulted. */
export type LifecycleGate = 'ok' | 'refused' | 'missing';

/**
 * Hold the document, and give back a posting claim that nothing live is
 * standing behind.
 *
 * The lock is what makes the answer hold for the rest of the request: without
 * it the release and the UPDATE below it are a check-then-act, and a posting
 * route running between them would re-claim the row. It is taken in the
 * module's usual document-first order, so there is no cycle.
 *
 * A refusal here has written nothing — `releaseUnpostedCaptureClaim` checks
 * liveness before it deletes anything — which is what makes the 400 safe under
 * `withAuth`'s commit-on-4xx.
 */
export async function releaseClaimForLifecycleAction(
  companyId: string,
  id: string,
): Promise<LifecycleGate> {
  const row = await lockCapturedDocumentForUpdate(companyId, id);
  if (!row) return 'missing';
  if (row.posted_at == null) return 'ok';
  return (await releaseUnpostedCaptureClaim(companyId, id)) ? 'ok' : 'refused';
}
