/**
 * finaliseVatReturn records the LOCK ROW's figures: nothing is computed a second time. The report
 * and the lock are made to disagree; the version must carry the lock's numbers.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  computeVatLockFigures: vi.fn(), lockVatPeriod: vi.fn(), assertVatGateClear: vi.fn(), insertVersion: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockFigures', () => ({ computeVatLockFigures: m.computeVatLockFigures }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({ lockVatPeriod: m.lockVatPeriod }));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => ({ assertVatGateClear: m.assertVatGateClear }));
vi.mock('@/modules/accounting/services/returns/returnVersionStore', () => ({
  insertVersion: m.insertVersion, nextVersion: () => ({ versionNo: 1, amendsVersionId: null }),
}));

import { finaliseVatReturn } from '@/modules/accounting/services/returns/finaliseVatReturn';

const actor = { userId: 'u1', role: 'admin' };
const lock = { id: 'lock-1', outputTax: 111, inputTax: 22, netVat: 89, postedThrough: '2026-06-30T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  m.computeVatLockFigures.mockResolvedValue({
    figures: { outputTax: 999, inputTax: 999, netVat: 0, postedThrough: 'x' },
    report: { rateCheck: { ties: true }, totals: { outputTax: 999, inputTax: 999, netVat: 0 }, boxes: [{ box: '1' }] },
  });
  m.assertVatGateClear.mockResolvedValue({ overridden: false });
  m.insertVersion.mockImplementation(async (v: unknown) => v);
});

describe('finaliseVatReturn', () => {
  it('stores the lock row figures and the report boxes, not the report totals', async () => {
    m.lockVatPeriod.mockResolvedValue({ lock, created: true });
    await finaliseVatReturn('c1', '2026-01-01', '2026-02-28', actor, [], {});
    expect(m.insertVersion).toHaveBeenCalledWith(expect.objectContaining({
      vatPeriodLockId: 'lock-1', postedThrough: lock.postedThrough,
      figures: { outputTax: 111, inputTax: 22, netVat: 89, sarsFields: [{ box: '1' }] },
    }));
  });

  it('refuses 409 and inserts nothing when the lock was not created by this call', async () => {
    m.lockVatPeriod.mockResolvedValue({ lock, created: false });
    await expect(finaliseVatReturn('c1', '2026-01-01', '2026-02-28', actor, [], {}))
      .rejects.toMatchObject({ status: 409 });
    expect(m.insertVersion).not.toHaveBeenCalled();
  });

  it('refuses a period failing the 15% check unless forced, before the gate and the lock', async () => {
    m.computeVatLockFigures.mockResolvedValue({
      figures: {}, report: { rateCheck: { ties: false, outputVariance: 5, inputVariance: 0 }, totals: {}, boxes: [] },
    });
    await expect(finaliseVatReturn('c1', '2026-01-01', '2026-02-28', actor, [], {}))
      .rejects.toMatchObject({ status: 400 });
    expect(m.assertVatGateClear).not.toHaveBeenCalled();
    expect(m.lockVatPeriod).not.toHaveBeenCalled();
  });
});
