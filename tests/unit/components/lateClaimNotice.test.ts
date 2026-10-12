/**
 * The late-claim notice: every response shape a late claim arrives in, one
 * sentence per claim, and nothing for a response without one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { notify } from '@/utils/toast';
import { NOTICE_LINE_FITS } from '@/components/accounting/noticeLine';
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
      title: 'Input VAT of R150.00 claimed late, in the VAT period from 2026-07-01', message: 'Period 2026-05-01 to 2026-06-30 is filed.' });
    expect(lateClaimNotice([lc, { ...lc, inputTax: 30 }])).toEqual({
      title: "2 documents' input VAT of R180.00 claimed late, in the VAT period from 2026-07-01", message: 'Their VAT periods are filed.' });
    // A period written longer than a date still leaves a line that fits.
    const wide = { ...lc, lockPeriod: { start: '2026-05-01T00:00:00.000Z', end: '2026-06-30T00:00:00.000Z' } };
    for (const n of [lateClaimNotice([lc]), lateClaimNotice([wide]), lateClaimNotice([lc, lc, lc])]) {
      expect(n.message.length, n.message).toBeLessThanOrEqual(NOTICE_LINE_FITS);
    }
    expect(lateClaimNotice([wide]).title).toContain('R150.00 claimed late');
  });

  it('the multi-document title starts at the EARLIEST claim date, whatever the order', () => {
    const a = { ...lc, claimDate: '2026-10-01' };
    const b = { ...lc, claimDate: '2026-08-01' };
    expect(lateClaimNotice([a, b]).title).toBe("2 documents' input VAT of R300.00 claimed late, in the VAT period from 2026-08-01");
    expect(lateClaimNotice([b, a]).title).toBe("2 documents' input VAT of R300.00 claimed late, in the VAT period from 2026-08-01");
  });

  it('several claims name their bills in line 2, falling back when the numbers do not fit; one claim keeps its period', () => {
    expect(lateClaimNotice([lc, lc], ['INV-12', 'INV-13']).message).toBe('Bills: INV-12, INV-13');
    expect(lateClaimNotice([lc, lc], ['INV-12', undefined]).message).toBe('Their VAT periods are filed.');
    const many = Array.from({ length: 50 }, (_, i) => `INV-${i + 1}`);
    const n = lateClaimNotice(many.map(() => lc), many);
    expect(n.message).toBe('Bills: INV-1, INV-2, INV-3, INV-4 and 46 more');
    expect(n.message.length).toBeLessThanOrEqual(NOTICE_LINE_FITS);
    // One late claim in a bulk run: line 2 holds the filed period (the fact needs the room), not the bill.
    expect(notifyLateClaims({ data: { results: [{ invoiceNumber: 'INV-12', lateClaim: lc }, { invoiceNumber: 'INV-13' }] } })).toBe(1);
    expect(notify.info).toHaveBeenLastCalledWith(expect.stringContaining('R150.00 claimed late'), 'Period 2026-05-01 to 2026-06-30 is filed.');
    vi.mocked(notify.info).mockReset();
    notifyLateClaims({ data: { results: [{ invoiceNumber: 'INV-12', lateClaim: lc }, { invoiceNumber: 'INV-14' }, { invoiceNumber: 'INV-13', lateClaim: lc }] } });
    expect(vi.mocked(notify.info).mock.calls[0]![1]).toBe('Bills: INV-12, INV-13');
  });

  it('shows one notice per response, summarised for a bulk action, and none without a late claim', () => {
    expect(notifyLateClaims({ data: { lateClaim: lc } })).toBe(1);
    expect(notify.info).toHaveBeenCalledWith('Input VAT of R150.00 claimed late, in the VAT period from 2026-07-01', 'Period 2026-05-01 to 2026-06-30 is filed.');
    vi.mocked(notify.info).mockReset();
    expect(notifyLateClaims({ data: { results: [{ lateClaim: lc }, { lateClaim: { ...lc, inputTax: 30 } }] } })).toBe(2);
    expect(vi.mocked(notify.info).mock.calls[0]![0]).toContain('R180.00');
    vi.mocked(notify.info).mockReset();
    expect(notifyLateClaims({ data: {} })).toBe(0);
    expect(notify.info).not.toHaveBeenCalled();
  });
});
