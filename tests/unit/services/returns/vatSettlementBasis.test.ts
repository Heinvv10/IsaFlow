/**
 * VR: what a VAT settlement is posted against (settlementBasis), wiring only (sql mocked). The VAT key is taken
 * shared BEFORE the version row is locked (an amend takes the key exclusive, then the row), the version read is
 * FOR SHARE and exact-period, and every refusal is raised before the caller writes. Figures and the "no row written"
 * property on real PG: tests/integration/vat-returns-settlement-{version,topup}.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', () => ({ takeVatLockShared: vi.fn() }));

import { sql } from '@/lib/neon';
import { takeVatLockShared } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { settlementBasis } from '@/modules/accounting/services/returns/vatSettlementVersion';

const CO = '00000000-0000-0000-0000-000000000001';
const V = '33333333-3333-3333-3333-333333333333';
const text = (i: number) => (vi.mocked(sql).mock.calls[i]![0] as TemplateStringsArray).join('?');
const version = (over: Record<string, unknown> = {}) => ({
  id: V, version_no: 2, status: 'finalised', figures: { outputTax: 3000, inputTax: 0, netVat: 3000 },
  lock_id: 'lock-1', unlocked_at: null, ...over,
});
const settled = (over: Record<string, unknown> = {}) => ({
  overlapping: 0, same: 1, mine: 0, output_tax: 1500, input_tax: 0, net_vat: 1500, ...over,
});
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { status?: number; refusalCode?: string });

describe('settlementBasis (VR)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes the VAT key shared first, then reads the version FOR SHARE for exactly the period', async () => {
    const order: string[] = [];
    vi.mocked(takeVatLockShared).mockImplementation(async () => { order.push('key'); });
    vi.mocked(sql).mockImplementation((async () => { order.push('sql'); return order.length === 2 ? [version()] : [settled()]; }) as never);
    const b = await settlementBasis(CO, '2026-02-01', '2026-03-31');
    expect(order).toEqual(['key', 'sql', 'sql']);
    expect(text(0)).toMatch(/FOR SHARE OF v/);
    expect(text(0)).toMatch(/status IN \('finalised', 'filed'\)/);
    expect(vi.mocked(sql).mock.calls[0]!.slice(1)).toEqual([CO, '2026-02-01', '2026-03-31']);
    expect(b).toEqual({
      version: { id: V, versionNo: 2, status: 'finalised', outputTax: 3000, inputTax: 0, netVat: 3000 },
      prior: { outputTax: 1500, inputTax: 0, netVat: 1500, count: 1 }, versionSettled: false,
    });
  });

  it('no live version: 409 VAT201_NOT_FINALISED, nothing read after it', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    expect(await refusal(settlementBasis(CO, '2026-02-01', '2026-03-31'))).toMatchObject({ status: 409, refusalCode: 'VAT201_NOT_FINALISED' });
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it.each([['released', { unlocked_at: '2026-04-02T00:00:00Z' }], ['missing', { lock_id: null }]])(
    'a %s VAT lock: 409 VAT201_LOCK_RELEASED', async (_label, over) => {
      vi.mocked(sql).mockResolvedValueOnce([version(over)] as never);
      expect(await refusal(settlementBasis(CO, '2026-02-01', '2026-03-31'))).toMatchObject({ status: 409, refusalCode: 'VAT201_LOCK_RELEASED' });
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    });

  it('a settlement of an overlapping, different period: 409 VAT_SETTLEMENT_PERIOD_OVERLAP', async () => {
    vi.mocked(sql).mockResolvedValueOnce([version()] as never).mockResolvedValueOnce([settled({ overlapping: 1 })] as never);
    expect(await refusal(settlementBasis(CO, '2026-07-01', '2026-07-31'))).toMatchObject({ status: 409, refusalCode: 'VAT_SETTLEMENT_PERIOD_OVERLAP' });
  });

  it('a row that already names this version is reported (the caller refuses it)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([version()] as never).mockResolvedValueOnce([settled({ mine: 1 })] as never);
    expect((await settlementBasis(CO, '2026-02-01', '2026-03-31')).versionSettled).toBe(true);
  });
});
