/**
 * Unit tests for flowWalletService.
 *
 * Every mutation runs through `migrationAdminSqlTx(label, async (tx) => ...)`
 * (S-07e: no app role writes the Flows tables) except `adminAdjust`, which
 * stays on the platform_admin request's `withTransaction`. Each is mocked as a
 * tagged-template `tx` stub — `tx` for the migration_admin pool, `reqTx` for
 * the request's — so the queries are scripted in the exact order the service
 * issues them, and a write on the wrong pool finds an empty script and fails.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const mockSql = vi.fn();
  const mockReqTx = vi.fn();
  return {
    sql: mockSql,
    withTransaction: vi.fn(async (fn: (tx: typeof mockReqTx) => Promise<unknown>) => {
      return fn(mockReqTx);
    }),
    // re-exposed so tests can reach the request's tx stub
    __reqTx: mockReqTx,
  };
});
vi.mock('@/lib/auth/migrationAdminPool', () => {
  const mockTx = vi.fn();
  return {
    migrationAdminSqlTx: vi.fn(async (_label: string, fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    __tx: mockTx,
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as neonMod from '@/lib/neon';
import * as adminPoolMod from '@/lib/auth/migrationAdminPool';
import {
  getWallet,
  startBundlePurchase,
  completeBundlePurchase,
  failBundlePurchase,
  getPurchaseStatus,
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

type Stub = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const { sql, __reqTx: reqTx } = neonMod as unknown as { sql: Stub; __reqTx: Stub };
const { __tx: tx, migrationAdminSqlTx: adminTx } = adminPoolMod as unknown as {
  __tx: Stub;
  migrationAdminSqlTx: MockedFunction<(label: string, fn: unknown) => Promise<unknown>>;
};
const labels = () => adminTx.mock.calls.map((c) => c[0]);
const sqlText = (call: unknown[] | undefined) => ((call?.[0] ?? []) as string[]).join('?');

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
      nudgeLevel: 'none',
      monthFlowsUsed: 0,
      monthResetAt: new Date('2026-04-01'),
    });
  });

  it('never selects payment_method_token: no app role may read it (migration 945)', async () => {
    sql.mockResolvedValueOnce([]);
    await getWallet('co-1');
    const text = sqlText(sql.mock.calls[0]);
    expect(text).not.toMatch(/payment_method_token/);
    expect(text).not.toMatch(/\*/);
    expect(text).toMatch(/balance_flows/);
  });

  it('does not carry a stored token through even if the row had one', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1', balance_flows: 1, auto_topup_enabled: true, auto_topup_bundle_id: 'b',
      payment_method_token: 'tok', nudge_level: 'none', month_flows_used: 0, month_reset_at: new Date(),
    }]);
    expect(await getWallet('co-1')).not.toHaveProperty('paymentMethodToken');
  });
});

// Start then complete: what the dev-only unpaid fallback (purchase.ts) does.
const purchaseBundle = async (companyId: string, bundleId: string) =>
  completeBundlePurchase((await startBundlePurchase(companyId, bundleId)).purchaseId);

describe('start + complete (two migration_admin transactions)', () => {
  it('inserts pending purchase then credits wallet + writes ledger', async () => {
    // ── startBundlePurchase transaction ───────────────────────────────
    // Bundle lookup
    tx.mockResolvedValueOnce([{
      id: 'bundle-1', name: 'Micro', flows: 100, price_cents: 1000, is_active: true,
    }]);
    // ensureWalletRow
    tx.mockResolvedValueOnce([]);
    // INSERT flow_purchases RETURNING id
    tx.mockResolvedValueOnce([{ id: 'purchase-1' }]);

    // ── completeBundlePurchase transaction ────────────────────────────
    // SELECT flow_purchases FOR UPDATE
    tx.mockResolvedValueOnce([{
      id: 'purchase-1', company_id: 'co-1', bundle_id: 'bundle-1',
      flows: 100, status: 'pending',
    }]);
    // ensureWalletRow
    tx.mockResolvedValueOnce([]);
    // lockWallet
    tx.mockResolvedValueOnce([{ balance_flows: 50, month_flows_used: 0 }]);
    // UPDATE flow_wallet
    tx.mockResolvedValueOnce([]);
    // UPDATE flow_purchases SET status='succeeded'
    tx.mockResolvedValueOnce([]);
    // INSERT flow_ledger
    tx.mockResolvedValueOnce([]);

    const result = await purchaseBundle('co-1', 'bundle-1');

    expect(result).toEqual({ purchaseId: 'purchase-1', balanceAfter: 150 });
    // Two migration_admin transactions: the pending row, then the credit.
    expect(labels()).toEqual(['flow_start_purchase', 'flow_complete_purchase']);
    expect(sql).not.toHaveBeenCalled();
  });

  it('throws when bundle is inactive', async () => {
    tx.mockResolvedValueOnce([{
      id: 'bundle-x', name: 'Bad', flows: 100, price_cents: 1000, is_active: false,
    }]);
    await expect(purchaseBundle('co-1', 'bundle-x')).rejects.toThrow(/not found or inactive/);
  });

  it('throws when bundle is missing', async () => {
    tx.mockResolvedValueOnce([]);
    await expect(purchaseBundle('co-1', 'missing')).rejects.toThrow(/not found or inactive/);
  });
});

describe('startBundlePurchase', () => {
  it('creates a pending flow_purchases row without mutating the wallet', async () => {
    tx.mockResolvedValueOnce([{
      id: 'bundle-1', name: 'Micro', flows: 100, price_cents: 1000, is_active: true,
    }]);
    tx.mockResolvedValueOnce([]);                             // ensureWalletRow
    tx.mockResolvedValueOnce([{ id: 'purchase-pending-1' }]); // INSERT flow_purchases

    const result = await startBundlePurchase('co-1', 'bundle-1', {
      paymentMethod: 'stitch_payment_link',
    });

    expect(result.purchaseId).toBe('purchase-pending-1');
    expect(result.bundle).toEqual({
      id: 'bundle-1', name: 'Micro', flows: 100, priceCents: 1000,
    });
    // Three tx calls — bundle lookup + ensureWallet + insert.  No UPDATE wallet,
    // no ledger row.
    expect(tx).toHaveBeenCalledTimes(3);
  });
});

describe('completeBundlePurchase', () => {
  it('credits wallet, marks succeeded, writes ledger for a pending row', async () => {
    // SELECT flow_purchases FOR UPDATE
    tx.mockResolvedValueOnce([{
      id: 'p-1', company_id: 'co-1', bundle_id: 'b-1', flows: 100, status: 'pending',
    }]);
    // ensureWalletRow
    tx.mockResolvedValueOnce([]);
    // lockWallet
    tx.mockResolvedValueOnce([{ balance_flows: 20, month_flows_used: 0 }]);
    // UPDATE flow_wallet
    tx.mockResolvedValueOnce([]);
    // UPDATE flow_purchases SET status
    tx.mockResolvedValueOnce([]);
    // INSERT flow_ledger
    tx.mockResolvedValueOnce([]);

    const result = await completeBundlePurchase('p-1');
    expect(result).toEqual({ purchaseId: 'p-1', balanceAfter: 120 });
    // Lock, wallet, purchase status and ledger: ONE transaction.
    expect(labels()).toEqual(['flow_complete_purchase']);
    expect(tx).toHaveBeenCalledTimes(6);
  });

  it('is idempotent — already-succeeded row is a no-op returning current balance', async () => {
    // SELECT flow_purchases FOR UPDATE → status='succeeded'
    tx.mockResolvedValueOnce([{
      id: 'p-1', company_id: 'co-1', bundle_id: 'b-1', flows: 100, status: 'succeeded',
    }]);
    // SELECT balance_flows
    tx.mockResolvedValueOnce([{ balance_flows: 250 }]);

    const result = await completeBundlePurchase('p-1');
    expect(result).toEqual({ purchaseId: 'p-1', balanceAfter: 250 });
    // No UPDATE / INSERT — just the two reads.
    expect(tx).toHaveBeenCalledTimes(2);
  });

  it('refuses to credit a row that was already marked failed', async () => {
    tx.mockResolvedValueOnce([{
      id: 'p-1', company_id: 'co-1', bundle_id: 'b-1', flows: 100, status: 'failed',
    }]);
    await expect(completeBundlePurchase('p-1')).rejects.toThrow(/already failed/);
  });

  it('throws when the purchase id does not exist', async () => {
    tx.mockResolvedValueOnce([]);
    await expect(completeBundlePurchase('p-missing')).rejects.toThrow(/not found/);
  });
});

describe('failBundlePurchase', () => {
  it('marks a pending row failed (idempotent — only affects status=pending)', async () => {
    tx.mockResolvedValueOnce([{ id: 'p-1' }]);
    await failBundlePurchase('p-1', 'cancelled');
    expect(tx).toHaveBeenCalledOnce();
    expect(sqlText(tx.mock.calls[0])).toMatch(/status = 'pending'/);
    expect(sql).not.toHaveBeenCalled();
  });

  it('no-ops when the row is already settled (no rows returned)', async () => {
    tx.mockResolvedValueOnce([]);
    await failBundlePurchase('p-1', 'cancelled');
    // Still only one query; no throw.
    expect(tx).toHaveBeenCalledOnce();
  });
});

describe('getPurchaseStatus', () => {
  it('returns mapped status when the purchase belongs to the company', async () => {
    sql.mockResolvedValueOnce([{
      id: 'p-1', status: 'succeeded', flows: 100,
      price_cents: 1000, payment_method: 'stitch_payment_link',
    }]);
    const result = await getPurchaseStatus('co-1', 'p-1');
    expect(result).toEqual({
      purchaseId: 'p-1', status: 'succeeded', flows: 100,
      priceCents: 1000, paymentMethod: 'stitch_payment_link',
    });
  });

  it('returns null when the row is missing or belongs to another tenant', async () => {
    sql.mockResolvedValueOnce([]);
    const result = await getPurchaseStatus('co-1', 'p-missing');
    expect(result).toBeNull();
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
    // Wallet lock, balance update and ledger row: ONE migration_admin transaction.
    expect(labels()).toEqual(['flow_deduct']);
    expect(tx).toHaveBeenCalledTimes(4);
    expect(sql).not.toHaveBeenCalled();

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
    expect(labels()).toEqual(['flow_refund']);
    expect(tx).toHaveBeenCalledTimes(4);

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
    reqTx.mockResolvedValueOnce([]);
    reqTx.mockResolvedValueOnce([{ balance_flows: 10, month_flows_used: 0 }]);
    reqTx.mockResolvedValueOnce([]);
    reqTx.mockResolvedValueOnce([]);

    const result = await adminAdjust('co-1', 50, 'support credit');
    expect(result.balanceAfter).toBe(60);
    // The platform_admin request's own transaction, never migration_admin.
    expect(adminTx).not.toHaveBeenCalled();
    expect(reqTx).toHaveBeenCalledTimes(4);
  });

  it('allows negative adjustments when balance is sufficient', async () => {
    reqTx.mockResolvedValueOnce([]);
    reqTx.mockResolvedValueOnce([{ balance_flows: 100, month_flows_used: 0 }]);
    reqTx.mockResolvedValueOnce([]);
    reqTx.mockResolvedValueOnce([]);

    const result = await adminAdjust('co-1', -30, 'clawback');
    expect(result.balanceAfter).toBe(70);
  });

  it('throws InsufficientFlowsError when negative adjust would underflow', async () => {
    reqTx.mockResolvedValueOnce([]);
    reqTx.mockResolvedValueOnce([{ balance_flows: 10, month_flows_used: 0 }]);

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
  const walletRow = (over: Record<string, unknown>) => ({
    company_id: 'co-1', balance_flows: 0, auto_topup_enabled: true,
    auto_topup_bundle_id: 'bundle-1', nudge_level: 'none', month_flows_used: 0, month_reset_at: new Date(),
    ...over,
  });

  it('returns disabled when autoTopupEnabled = false', async () => {
    sql.mockResolvedValueOnce([walletRow({ auto_topup_enabled: false, auto_topup_bundle_id: null })]);
    const r = await triggerAutoTopup('co-1');
    expect(r).toEqual({ success: false, reason: 'disabled' });
  });

  it('returns disabled when the company has no wallet', async () => {
    sql.mockResolvedValueOnce([]);
    expect(await triggerAutoTopup('co-1')).toEqual({ success: false, reason: 'disabled' });
  });

  it('returns no_bundle when bundle not configured', async () => {
    sql.mockResolvedValueOnce([walletRow({ auto_topup_bundle_id: null })]);
    const r = await triggerAutoTopup('co-1');
    expect(r.reason).toBe('no_bundle');
  });

  it('returns no_payment_method in v1 (no gateway yet) and credits nothing', async () => {
    sql.mockResolvedValueOnce([walletRow({})]);
    const r = await triggerAutoTopup('co-1');
    expect(r).toEqual({ success: false, reason: 'no_payment_method' });
    expect(adminTx).not.toHaveBeenCalled();
  });

  it('never credits, even when the wallet row carries a stored token', async () => {
    // Before S-07e a truthy payment_method_token made this buy the bundle with no payment.
    sql.mockResolvedValueOnce([walletRow({ payment_method_token: 'tok_forged' })]);
    const r = await triggerAutoTopup('co-1');
    expect(r).toEqual({ success: false, reason: 'no_payment_method' });
    expect(adminTx).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });
});

describe('setAutoTopup', () => {
  it('writes the new config', async () => {
    tx.mockResolvedValueOnce([]); // ensureWalletRow
    tx.mockResolvedValueOnce([]); // UPDATE
    await setAutoTopup('co-1', true, 'bundle-1');
    expect(tx).toHaveBeenCalledTimes(2);
    expect(labels()).toEqual(['flow_set_auto_topup']);
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
    expect(adminTx).not.toHaveBeenCalled();
  });

  it('persists when level has changed', async () => {
    sql.mockResolvedValueOnce([{
      company_id: 'co-1', balance_flows: 100, auto_topup_enabled: false,
      auto_topup_bundle_id: null, payment_method_token: null,
      nudge_level: 'none', month_flows_used: 2000, month_reset_at: new Date(),
    }]);
    tx.mockResolvedValueOnce([]); // UPDATE, on the migration_admin pool
    const level = await recalculateNudge('co-1');
    expect(level).toBe('yellow');
    expect(sql).toHaveBeenCalledTimes(1); // the wallet read stays on the caller's pool
    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx.mock.calls[0]?.slice(1)).toEqual(['yellow', 'co-1']);
  });
});

describe('resetMonthlyCounter', () => {
  it('returns number of reset rows', async () => {
    tx.mockResolvedValueOnce([
      { company_id: 'co-1' }, { company_id: 'co-2' }, { company_id: 'co-3' },
    ]);
    const r = await resetMonthlyCounter();
    expect(r.companiesReset).toBe(3);
    expect(labels()).toEqual(['flow_reset_month']);
    expect(sql).not.toHaveBeenCalled();
  });
});
