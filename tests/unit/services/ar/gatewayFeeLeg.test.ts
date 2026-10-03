/**
 * R-181 (PR #618 review at 72b132f52, L1): postGatewayFee posts any whole-cent fee leg. It used to
 * skip `fee <= 0.01`, so a merchant's R0.01 share (R118.50 charged, requested_amount R115, fees
 * R3.51) was computed and silently dropped, leaving Bank a cent above the deposit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn(async () => ({ id: 'exp-1' })) }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-fee' })),
  postJournalEntry: vi.fn(async () => undefined),
}));

import { postGatewayFee } from '@/modules/accounting/services/ar/gatewayFeeService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';

const create = createJournalEntry as unknown as ReturnType<typeof vi.fn>;
const receipt = (feeRand: number | null) => ({ companyId: 'co-1', invoiceId: 'inv-1', reference: 'r181_fee',
  requestedCents: 11500, reported: { amountCents: 11850, currency: 'ZAR' }, feeRand });

beforeEach(() => { create.mockClear(); });

describe('postGatewayFee', () => {
  it.each([
    ['one cent', 0.01, 0.01],
    ['R3.50', 3.5, 3.5],
  ])('posts %s', async (_label, feeRand, posted) => {
    await postGatewayFee(receipt(feeRand), 'user-1', 'bank-1', '2026-10-02');
    expect(create).toHaveBeenCalledTimes(1);
    const lines = (create.mock.calls[0]![1] as { lines: { debit: number; credit: number }[] }).lines;
    expect(lines.map((l) => [l.debit, l.credit])).toEqual([[posted, 0], [0, posted]]);
  });

  it.each([['no fee', null], ['zero', 0], ['a fraction of a cent', 0.004]])('posts nothing for %s', async (_label, feeRand) => {
    await postGatewayFee(receipt(feeRand), 'user-1', 'bank-1', '2026-10-02');
    expect(create).not.toHaveBeenCalled();
  });
});
