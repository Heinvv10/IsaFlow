/**
 * The late-claim notice: every response shape a late claim arrives in, one
 * sentence per claim, and nothing for a response without one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import { lateClaimNotice, lateClaimsIn, notifyLateClaims } from '@/components/accounting/lateClaimNotice';

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

  it('the title says how much and from when; the second line holds only what fits', () => {
    expect(lateClaimNotice([lc])).toEqual({
      title: 'Input VAT of R150.00 claimed late, from 2026-07-01', message: 'Period 2026-05-01 to 2026-06-30 is filed.' });
    expect(lateClaimNotice([lc, { ...lc, inputTax: 30 }])).toEqual({
      title: "2 documents' input VAT of R180.00 claimed late, from 2026-07-01", message: 'Their VAT periods are filed.' });
    // A period written longer than a date still leaves a line that fits.
    const wide = { ...lc, lockPeriod: { start: '2026-05-01T00:00:00.000Z', end: '2026-06-30T00:00:00.000Z' } };
    for (const n of [lateClaimNotice([lc]), lateClaimNotice([wide]), lateClaimNotice([lc, lc, lc])]) {
      expect(n.message.length, n.message).toBeLessThanOrEqual(45);
    }
    expect(lateClaimNotice([wide]).title).toContain('R150.00 claimed late');
  });

  it('shows one notice per response, summarised for a bulk action, and none without a late claim', () => {
    expect(notifyLateClaims({ data: { lateClaim: lc } })).toBe(1);
    expect(notify.info).toHaveBeenCalledWith('Input VAT of R150.00 claimed late, from 2026-07-01', 'Period 2026-05-01 to 2026-06-30 is filed.');
    vi.mocked(notify.info).mockReset();
    expect(notifyLateClaims({ data: { results: [{ lateClaim: lc }, { lateClaim: { ...lc, inputTax: 30 } }] } })).toBe(2);
    expect(vi.mocked(notify.info).mock.calls[0]![0]).toContain('R180.00');
    vi.mocked(notify.info).mockReset();
    expect(notifyLateClaims({ data: {} })).toBe(0);
    expect(notify.info).not.toHaveBeenCalled();
  });
});
