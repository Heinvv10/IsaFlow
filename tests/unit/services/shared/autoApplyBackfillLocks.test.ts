/**
 * The contended back-fill source's message (#1701 round 12): the MCP registry stores a successful write's result under
 * its idempotency_key and replays it on the same key (registry.findIdempotentReplay; a partial run that applied other
 * sources wrote, so it is kept), so the retry must name a NEW key or the skipped note never applies.
 */
import { describe, expect, it } from 'vitest';
import { contendedReason } from '@/modules/accounting/services/shared/autoApplyBackfillLocks';

describe('contendedReason', () => {
  it('names the note and says to re-run with a NEW idempotency_key', () => {
    expect(contendedReason('CN-7')).toBe('Credit note CN-7 is being changed by another request (an approval, apply, unapply or cancel); it was '
      + 'skipped. Re-run auto_apply_unapplied once that request has finished, with a NEW idempotency_key: the same key returns '
      + 'this result again (it applied the other sources, so it is kept), and the skipped note would never apply.');
  });
});
