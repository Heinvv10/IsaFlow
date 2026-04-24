/**
 * Unit tests for flowWalletService.
 *
 * Transactions run through `withTransaction(async (tx) => ...)` so we mock
 * `tx` as a tagged-template stub that just delegates to the same `sql` mock
 * stack — queries are scripted in the exact order the service issues them.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const mockSql = vi.fn();
  const mockTx = vi.fn();
  return {
    sql: mockSql,
    withTransaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
      return fn(mockTx);
    }),
    // re-exposed so tests can reach the tx stub
    __tx: mockTx,
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as neonMod from '@/lib/neon';
import {
  getWallet,
  purchaseBundle,
  deductFlows,
  refundFlows,
  adminAdjust,
  triggerAutoTopup,
  setAutoTopup,
  recalculateNudge,
  resetMonthlyCounter,
  InsufficientFlowsError,
  __test,
} from '@/modules/billing/services/flowWalletService';

const { sql, __tx: tx } = neonMod as unknown as {
  sql: MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
  __tx: MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeNudge (pure)', () => {
  const compute = __test.computeNudge;

  it.each([
    [0,    'none'],
    [1_799, 'none'],
    [1_800, 'yellow'],
    [2_399, 'yellow'],
    [2_400, 'orange'],
    [2_899, 'orange'],
    [2_900, 'red'],
    [10_000, 'red'],
  ])('monthFlowsUsed=%i → %s', (used, level) => {
    expect(compute(used as number)).toBe(level);
  });
});

describe('getWallet', () => {
  it('returns null when no wallet row exists', async () => {
    sql.mockResolvedValueOnce([]);
    const w = await getWallet('co-x');
    expect(w).toBeNull();
  });

  it('maps snake_case → camelCase', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1',
      balance_flows: 250,
      auto_topup_enabled: false,
      auto_topup_bundle_id: null,
      payment_method_token: null,
      nudge_level: 'none',
      month_flows_used: 0,
      month_reset_at: new Date('2026-04-01'),
    }]);
    const w = await getWallet('co-1');
    expect(w).toEqual({
      companyId: 'co-1',
      balance: 250,
      autoTopupEnabled: false,
      autoTopupBundleId: null,
      paymentMethodToken: null,
      nudgeLevel: 'none',
      monthFlowsUsed: 0,
      monthResetAt: new Date('2026-04-01'),
    });
  });
});

describe('purchaseBundle', () => {
  it('inserts purchase, credits wallet, writes ledger — atomically', async () => {
    // Bundle lookup
    tx.mockResolvedValueOnce([{
      id: 'bundle-1', flows: 100, price_cents: 1000, is_active: true,
    }]);
    // ensureWalletRow INSERT ... ON CONFLICT — no return value
    tx.mockResolvedValueOnce([]);
    // lockWallet SELECT FOR UPDATE
    tx.mockResolvedValueOnce([{ balance_flows: 50, month_flows_used: 0 }]);
    // INSERT flow_purchases RETURNING id
    tx.mockResolvedValueOnce([{ id: 'purchase-1' }]);
    // UPDATE flow_wallet
    tx.mockResolvedValueOnce([]);
    // INSERT flow_ledger
    tx.mockResolvedValueOnce([]);

    const result = await purchaseBundle('co-1', 'bundle-1');

    expect(result).toEqual({ purchaseId: 'purchase-1', balanceAfter: 150 });
    expect(tx).toHaveBeenCalledTimes(6);
  });

  it('throws when bundle is inactive', async () => {
    tx.mockResolvedValueOnce([{
      id: 'bundle-x', flows: 100, price_cents: 1000, is_active: false,
    }]);
    await expect(purchaseBundle('co-1', 'bundle-x')).rejects.toThrow(/not found or inactive/);
  });

  it('throws when bundle is missing', async () => {
    tx.mockResolvedValueOnce([]);
    await expect(purchaseBundle('co-1', 'missing')).rejects.toThrow(/not found or inactive/);
  });
});

describe('deductFlows', () => {
  it('decrements balance, increments month_flows_used, writes ledger', async () => {
    tx.mockResolvedValueOnce([]);                                                     // ensureWalletRow
    tx.mockResolvedValueOnce([{ balance_flows: 100, month_flows_used: 500 }]);        // lockWallet
    tx.mockResolvedValueOnce([]);                                                     // UPDATE wallet
    tx.mockResolvedValueOnce([]);                                                     // INSERT ledger

    const result = await deductFlows('co-1', 3, 'invoice.create', 'inv-1');
    expect(result).toEqual({ balanceAfter: 97 });

    // Verify the UPDATE arguments include the computed nudge (still 'none' at 503)
    const updateCall = tx.mock.calls[2];
    const updateValues = updateCall?.slice(1) ?? [];
    expect(updateValues).toContain(97);   // new balance
    expect(updateValues).toContain(503);  // new month usage
    expect(updateValues).toContain('none'); // nudge level
  });

  it('throws InsufficientFlowsError when balance < cost', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([{ balance_flows: 2, month_flows_used: 0 }]);

    await expect(deductFlows('co-1', 3, 'invoice.create')).rejects.toBeInstanceOf(
      InsufficientFlowsError,
    );
  });

  it('rejects non-positive flowCost', async () => {
    await expect(deductFlows('co-1', 0, 'invoice.create')).rejects.toThrow(/positive integer/);
    await expect(deductFlows('co-1', -1, 'invoice.create')).rejects.toThrow(/positive integer/);
    await expect(deductFlows('co-1', 1.5, 'invoice.create')).rejects.toThrow(/positive integer/);
  });

  it('escalates nudge to yellow once month_flows_used crosses 1800', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([{ balance_flows: 100, month_flows_used: 1799 }]);
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);

    await deductFlows('co-1', 3, 'invoice.create');

    const updateCall = tx.mock.calls[2];
    expect(updateCall?.slice(1)).toContain('yellow');
  });
});

describe('refundFlows', () => {
  it('credits balance, unwinds month usage, writes refund ledger row', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([{ balance_flows: 97, month_flows_used: 503 }]);
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);

    const result = await refundFlows('co-1', 3, 'invoice.create', 'inv-1');
    expect(result).toEqual({ balanceAfter: 100 });

    const updateCall = tx.mock.calls[2];
    expect(updateCall?.slice(1)).toContain(100);
    expect(updateCall?.slice(1)).toContain(500);
  });

  it('clamps month_flows_used at 0 (never goes negative)', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([{ balance_flows: 0, month_flows_used: 1 }]);
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);

    await refundFlows('co-1', 5, 'invoice.create');

    const updateCall = tx.mock.calls[2];
    expect(updateCall?.slice(1)).toContain(0); // month_flows_used clamped
  });
});

describe('adminAdjust', () => {
  it('credits positive flows', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([{ balance_flows: 10, month_flows_used: 0 }]);
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);

    const result = await adminAdjust('co-1', 50, 'support credit');
    expect(result.balanceAfter).toBe(60);
  });

  it('allows negative adjustments when balance is sufficient', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([{ balance_flows: 100, month_flows_used: 0 }]);
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);

    const result = await adminAdjust('co-1', -30, 'clawback');
    expect(result.balanceAfter).toBe(70);
  });

  it('throws InsufficientFlowsError when negative adjust would underflow', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([{ balance_flows: 10, month_flows_used: 0 }]);

    await expect(adminAdjust('co-1', -50, 'clawback')).rejects.toBeInstanceOf(
      InsufficientFlowsError,
    );
  });

  it('rejects zero / non-integer / blank reason', async () => {
    await expect(adminAdjust('co-1', 0, 'x')).rejects.toThrow(/non-zero integer/);
    await expect(adminAdjust('co-1', 1.5, 'x')).rejects.toThrow(/non-zero integer/);
    await expect(adminAdjust('co-1', 5, '')).rejects.toThrow(/reason is required/);
    await expect(adminAdjust('co-1', 5, '   ')).rejects.toThrow(/reason is required/);
  });
});

describe('triggerAutoTopup (v1)', () => {
  it('returns disabled when autoTopupEnabled = false', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1', balance_flows: 0, auto_topup_enabled: false,
      auto_topup_bundle_id: null, payment_method_token: null,
      nudge_level: 'none', month_flows_used: 0, month_reset_at: new Date(),
    }]);
    const r = await triggerAutoTopup('co-1');
    expect(r).toEqual({ success: false, reason: 'disabled' });
  });

  it('returns no_bundle when bundle not configured', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1', balance_flows: 0, auto_topup_enabled: true,
      auto_topup_bundle_id: null, payment_method_token: 'tok',
      nudge_level: 'none', month_flows_used: 0, month_reset_at: new Date(),
    }]);
    const r = await triggerAutoTopup('co-1');
    expect(r.reason).toBe('no_bundle');
  });

  it('returns no_payment_method in v1 (no gateway yet)', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1', balance_flows: 0, auto_topup_enabled: true,
      auto_topup_bundle_id: 'bundle-1', payment_method_token: null,
      nudge_level: 'none', month_flows_used: 0, month_reset_at: new Date(),
    }]);
    const r = await triggerAutoTopup('co-1');
    expect(r.reason).toBe('no_payment_method');
  });
});

describe('setAutoTopup', () => {
  it('writes the new config', async () => {
    tx.mockResolvedValueOnce([]); // ensureWalletRow
    tx.mockResolvedValueOnce([]); // UPDATE
    await setAutoTopup('co-1', true, 'bundle-1');
    expect(tx).toHaveBeenCalledTimes(2);
  });
});

describe('recalculateNudge', () => {
  it('is a no-op when level is already correct', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1', balance_flows: 100, auto_topup_enabled: false,
      auto_topup_bundle_id: null, payment_method_token: null,
      nudge_level: 'none', month_flows_used: 500, month_reset_at: new Date(),
    }]);
    const level = await recalculateNudge('co-1');
    expect(level).toBe('none');
    // Only the SELECT ran; no UPDATE.
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('persists when level has changed', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1', balance_flows: 100, auto_topup_enabled: false,
      auto_topup_bundle_id: null, payment_method_token: null,
      nudge_level: 'none', month_flows_used: 2000, month_reset_at: new Date(),
    }]);
    sql.mockResolvedValueOnce([]); // UPDATE
    const level = await recalculateNudge('co-1');
    expect(level).toBe('yellow');
    expect(sql).toHaveBeenCalledTimes(2);
  });
});

describe('resetMonthlyCounter', () => {
  it('returns number of reset rows', async () => {
    sql.mockResolvedValueOnce([
      { company_id: 'co-1' }, { company_id: 'co-2' }, { company_id: 'co-3' },
    ]);
    const r = await resetMonthlyCounter();
    expect(r.companiesReset).toBe(3);
  });
});
