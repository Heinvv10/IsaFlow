/**
 * The late-claim notice: every response shape a late claim arrives in, one
 * sentence per claim, and nothing for a response without one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import { lateClaimMessage, lateClaimsIn, notifyLateClaims } from '@/components/accounting/lateClaimNotice';

const lc = { claimDate: '2026-07-01', lockPeriod: { start: '2026-05-01', end: '2026-06-30' }, inputTax: 150 };

describe('late claim notice', () => {
  beforeEach(() => vi.mocked(notify.info).mockReset());

  it('reads data.lateClaim, data.claim.lateClaim and data.results[].lateClaim', () => {
    expect(lateClaimsIn({ data: { lateClaim: lc } })).toEqual([lc]);
    expect(lateClaimsIn({ data: { claim: { lateClaim: lc } } })).toEqual([lc]);
    expect(lateClaimsIn({ data: { results: [{ ok: true, lateClaim: lc }, { ok: true }] } })).toEqual([lc]);
    expect(lateClaimsIn({ data: { id: 'x' } })).toEqual([]);
    expect(lateClaimsIn(null)).toEqual([]);
  });

  it('says how much, from when, and which period is filed', () => {
    expect(lateClaimMessage(lc)).toBe(
      'Input VAT of R150.00 was claimed late, in the VAT period starting 2026-07-01 (the period 2026-05-01 to 2026-06-30 is filed).');
  });

  it('shows one notice per response, summarised for a bulk action, and none without a late claim', () => {
    expect(notifyLateClaims({ data: { lateClaim: lc } })).toBe(1);
    expect(notify.info).toHaveBeenCalledWith('VAT claimed in a later period', lateClaimMessage(lc));
    vi.mocked(notify.info).mockReset();
    expect(notifyLateClaims({ data: { results: [{ lateClaim: lc }, { lateClaim: { ...lc, inputTax: 30 } }] } })).toBe(2);
    expect(vi.mocked(notify.info).mock.calls[0]![1]).toContain('R180.00');
    vi.mocked(notify.info).mockReset();
    expect(notifyLateClaims({ data: {} })).toBe(0);
    expect(notify.info).not.toHaveBeenCalled();
  });
});
