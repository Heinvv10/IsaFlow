/**
 * finaliseVatReturn with its collaborators mocked: the version records the LOCK ROW's figures
 * (nothing is computed a second time), a lock this call did not create is a 409, the 15% check
 * and the vat_returns mismatch refuse before the gate and the lock, and force / acknowledgement
 * let them through.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  computeVatLockFigures: vi.fn(), lockVatPeriod: vi.fn(), assertVatGateClear: vi.fn(),
  insertVersion: vi.fn(), listVersionRows: vi.fn(), assertNoLiveOverlap: vi.fn(), getVatReturnRecord: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockFigures', () => ({ computeVatLockFigures: m.computeVatLockFigures }));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({ lockVatPeriod: m.lockVatPeriod }));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => ({ assertVatGateClear: m.assertVatGateClear }));
vi.mock('@/modules/accounting/services/returns/vatReturnRecord', () => ({ getVatReturnRecord: m.getVatReturnRecord }));
vi.mock('@/modules/accounting/services/returns/returnVersionStore', () => ({
  insertVersion: m.insertVersion, listVersionRows: m.listVersionRows, assertNoLiveOverlap: m.assertNoLiveOverlap,
  nextVersion: () => ({ versionNo: 1, amendsVersionId: null }),
}));

import { finaliseVatReturn } from '@/modules/accounting/services/returns/finaliseVatReturn';

const actor = { userId: 'u1', role: 'admin' };
const lock = { id: 'lock-1', outputTax: 111, inputTax: 22, netVat: 89, postedThrough: '2026-06-30T00:00:00.000Z' };
const run = (opts = {}) => finaliseVatReturn('c1', '2026-02-01', '2026-03-31', actor, opts);

beforeEach(() => {
  vi.clearAllMocks();
  m.computeVatLockFigures.mockResolvedValue({
    figures: { outputTax: 999, inputTax: 999, netVat: 0, postedThrough: 'x' },
    report: { rateCheck: { ties: true }, totals: { outputTax: 999, inputTax: 999, netVat: 0 }, boxes: [{ box: '1' }] },
  });
  m.assertVatGateClear.mockResolvedValue({ overridden: false });
  m.assertNoLiveOverlap.mockResolvedValue(undefined);
  m.getVatReturnRecord.mockResolvedValue(null);
  m.listVersionRows.mockResolvedValue([]);
  m.lockVatPeriod.mockResolvedValue({ lock, created: true });
  m.insertVersion.mockImplementation(async (v: unknown) => v);
});

describe('finaliseVatReturn', () => {
  it('stores the lock row figures and the report boxes, not the report totals', async () => {
    await run();
    expect(m.insertVersion).toHaveBeenCalledWith(expect.objectContaining({
      vatPeriodLockId: 'lock-1', postedThrough: lock.postedThrough,
      figures: { outputTax: 111, inputTax: 22, netVat: 89, sarsFields: [{ box: '1' }] },
    }));
  });

  it('refuses 409 and inserts nothing when the lock was not created by this call', async () => {
    m.lockVatPeriod.mockResolvedValue({ lock, created: false });
    await expect(run()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Unlock it first/) });
    expect(m.insertVersion).not.toHaveBeenCalled();
  });

  it('says "just finalised" when a version already names that lock (the loser of a race)', async () => {
    m.lockVatPeriod.mockResolvedValue({ lock, created: false });
    m.listVersionRows.mockResolvedValue([{ vatPeriodLockId: 'lock-1' }]);
    await expect(run()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/just finalised/) });
  });

  it('refuses a period failing the 15% check, before the gate and the lock; force records it', async () => {
    m.computeVatLockFigures.mockResolvedValue({
      figures: {}, report: { rateCheck: { ties: false, outputVariance: 5, inputVariance: 0 }, totals: {}, boxes: [] },
    });
    await expect(run()).rejects.toMatchObject({ status: 400 });
    expect(m.assertVatGateClear).not.toHaveBeenCalled();
    expect(m.lockVatPeriod).not.toHaveBeenCalled();
    await run({ force: true });
    expect(m.insertVersion).toHaveBeenCalledTimes(1);
  });

  it('refuses a submitted vat_returns record with other figures before the gate; acknowledging keeps the reason', async () => {
    const rec = { status: 'submitted', outputTax: 1, inputTax: 0, netVat: 1, mismatch: true };
    m.getVatReturnRecord.mockResolvedValue(rec);
    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(m.assertVatGateClear).not.toHaveBeenCalled();
    await run({ acknowledgeVatReturnMismatch: { reason: 'old test record' } });
    expect(m.insertVersion).toHaveBeenCalledWith(expect.objectContaining({
      figures: expect.objectContaining({
        meta: { vatReturnMismatch: { reason: 'old test record', acknowledgedBy: 'u1', vatReturn: rec } },
      }),
    }));
  });
});
