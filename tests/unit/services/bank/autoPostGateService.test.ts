import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/provisionalPostingService', () => ({
  postProvisional: vi.fn(),
}));

import {
  evaluate,
  getAutoPostSettings,
  updateAutoPostSettings,
  type AutoPostSettings,
  type GateTx,
} from '@/modules/accounting/services/bank/autoPostGateService';

const ON: AutoPostSettings = { enabled: true, minConfidence: 0.9, amountCap: 10000 };
const tx = (over: Partial<GateTx> = {}): GateTx => ({
  status: 'imported', amount: -500, suggestedGlAccountId: 'gl-1', ...over,
});

describe('evaluate — decision ladder', () => {
  it('skips when disabled', () => {
    expect(evaluate(tx(), 0.99, { ...ON, enabled: false })).toEqual({ outcome: 'skip', reason: 'disabled' });
  });

  it('skips when tx not imported', () => {
    expect(evaluate(tx({ status: 'allocated' }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'not eligible' });
  });

  it('skips when confidence below threshold', () => {
    expect(evaluate(tx(), 0.89, ON)).toEqual({ outcome: 'skip', reason: 'confidence too low' });
  });

  it('posts when confidence is exactly at threshold', () => {
    expect(evaluate(tx(), 0.9, ON)).toEqual({ outcome: 'post' });
  });

  it('skips when amount over cap', () => {
    expect(evaluate(tx({ amount: -10000.01 }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });

  it('posts when amount is exactly at the cap', () => {
    expect(evaluate(tx({ amount: -10000 }), 0.99, ON)).toEqual({ outcome: 'post' });
  });

  it('treats cap of 0 as uncapped', () => {
    expect(evaluate(tx({ amount: -999999 }), 0.99, { ...ON, amountCap: 0 })).toEqual({ outcome: 'post' });
  });

  it('skips suggestion-path tx with no target', () => {
    expect(evaluate(tx({ suggestedGlAccountId: null }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'no target' });
  });

  it('defers confidence + no-target rungs when confidence is null (provisional path)', () => {
    expect(evaluate(tx({ suggestedGlAccountId: null }), null, ON)).toEqual({ outcome: 'post' });
  });

  it('enforces status on the provisional path (null confidence)', () => {
    expect(evaluate(tx({ status: 'allocated' }), null, ON)).toEqual({ outcome: 'skip', reason: 'not eligible' });
  });

  it('still enforces enabled/status/cap on the provisional path', () => {
    expect(evaluate(tx({ amount: -20000, suggestedGlAccountId: null }), null, ON))
      .toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });
});

describe('getAutoPostSettings', () => {
  beforeEach(() => sqlMock.mockReset());

  it('returns disabled defaults when no row exists', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const s = await getAutoPostSettings('co-1');
    expect(s).toEqual({ enabled: false, minConfidence: 0.9, amountCap: 10000 });
  });

  it('maps an existing row', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.85', amount_cap: '5000' }]);
    const s = await getAutoPostSettings('co-1');
    expect(s).toEqual({ enabled: true, minConfidence: 0.85, amountCap: 5000 });
  });
});

describe('updateAutoPostSettings', () => {
  beforeEach(() => sqlMock.mockReset());

  it('rejects a min_confidence outside (0,1]', async () => {
    await expect(updateAutoPostSettings('co-1', { minConfidence: 1.5 }, 'u-1'))
      .rejects.toThrow(/min_confidence/);
  });

  it('rejects a negative amount cap', async () => {
    await expect(updateAutoPostSettings('co-1', { amountCap: -1 }, 'u-1'))
      .rejects.toThrow(/amount_cap/);
  });

  it('upserts and returns the merged settings', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.9', amount_cap: '10000' }]);
    const s = await updateAutoPostSettings('co-1', { enabled: true }, 'u-1');
    expect(s.enabled).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('persists enabled:false without dropping it', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: false, min_confidence: '0.9', amount_cap: '10000' }]);
    const s = await updateAutoPostSettings('co-1', { enabled: false }, 'u-1');
    expect(s.enabled).toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('accepts amountCap 0 (uncapped) and forwards it', async () => {
    sqlMock.mockResolvedValueOnce([{ enabled: true, min_confidence: '0.9', amount_cap: '0' }]);
    const s = await updateAutoPostSettings('co-1', { amountCap: 0 }, 'u-1');
    expect(s.amountCap).toBe(0);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
