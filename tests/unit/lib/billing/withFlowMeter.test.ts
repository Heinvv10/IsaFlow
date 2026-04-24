/**
 * Unit tests for withFlowMeter — non-PAYG passthrough, 402 on empty wallet,
 * refund on handler throw / 4xx, nudge recalc on success.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn() }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: vi.fn(),
  refundFlows: vi.fn(),
  triggerAutoTopup: vi.fn(),
  recalculateNudge: vi.fn(),
  InsufficientFlowsError: class InsufficientFlowsError extends Error {
    constructor(public balance: number, public required: number) {
      super(`insufficient_flows: balance ${balance} < required ${required}`);
      this.name = 'InsufficientFlowsError';
    }
  },
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';
import {
  deductFlows,
  refundFlows,
  triggerAutoTopup,
  recalculateNudge,
  InsufficientFlowsError,
} from '@/modules/billing/services/flowWalletService';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';

const mockGetPlan = getCompanyPlan as MockedFunction<typeof getCompanyPlan>;
const mockDeduct  = deductFlows as MockedFunction<typeof deductFlows>;
const mockRefund  = refundFlows as MockedFunction<typeof refundFlows>;
const mockTopup   = triggerAutoTopup as MockedFunction<typeof triggerAutoTopup>;
const mockNudge   = recalculateNudge as MockedFunction<typeof recalculateNudge>;

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNudge.mockResolvedValue('none');
});

describe('withFlowMeter', () => {
  it('rejects non-positive flow cost at construction time', () => {
    expect(() => withFlowMeter('invoice.create', 0)).toThrow(/positive integer/);
    expect(() => withFlowMeter('invoice.create', -1)).toThrow(/positive integer/);
    expect(() => withFlowMeter('invoice.create', 1.5)).toThrow(/positive integer/);
  });

  it('passes through non-PAYG plans without deducting', async () => {
    mockGetPlan.mockResolvedValueOnce({ planCode: 'starter', planId: 'p', subscriptionId: 's' });
    const handler = vi.fn(async (_req, res: ReturnType<typeof mockRes>) => { res.statusCode = 200; });

    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();
    await wrapped({ companyId: 'co-1' } as never, res as never);

    expect(handler).toHaveBeenCalledOnce();
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(res.headers['X-Flow-Balance-After']).toBeUndefined();
  });

  it('passes through when company has no active subscription', async () => {
    mockGetPlan.mockResolvedValueOnce(null);
    const handler = vi.fn(async (_req, res: ReturnType<typeof mockRes>) => { res.statusCode = 200; });

    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();
    await wrapped({ companyId: 'co-1' } as never, res as never);

    expect(handler).toHaveBeenCalledOnce();
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('debits, runs handler, and recalcs nudge on a clean 200', async () => {
    mockGetPlan.mockResolvedValueOnce({ planCode: 'payg', planId: 'p', subscriptionId: 's' });
    mockDeduct.mockResolvedValueOnce({ balanceAfter: 97 });
    const handler = vi.fn(async (_req, res: ReturnType<typeof mockRes>) => { res.statusCode = 200; });

    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();
    await wrapped({ companyId: 'co-1' } as never, res as never);

    expect(mockDeduct).toHaveBeenCalledWith('co-1', 3, 'invoice.create', null);
    expect(handler).toHaveBeenCalledOnce();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(res.headers['X-Flow-Balance-After']).toBe('97');
    expect(res.headers['X-Flow-Operation']).toBe('invoice.create');
    expect(res.headers['X-Flow-Cost']).toBe('3');
    // Nudge recalc is fire-and-forget; wait a tick to let the microtask run.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNudge).toHaveBeenCalledWith('co-1');
  });

  it('returns 402 when wallet is empty and auto-topup fails', async () => {
    mockGetPlan.mockResolvedValueOnce({ planCode: 'payg', planId: 'p', subscriptionId: 's' });
    mockDeduct.mockRejectedValueOnce(new InsufficientFlowsError(2, 3));
    mockTopup.mockResolvedValueOnce({ success: false, reason: 'no_payment_method' });

    const handler = vi.fn();
    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();
    await wrapped({ companyId: 'co-1' } as never, res as never);

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: 'PAYMENT_REQUIRED',
        details: expect.objectContaining({ reason: 'insufficient_flows', balance: 2, required: 3 }),
      }),
    }));
  });

  it('retries the debit when auto-topup succeeds', async () => {
    mockGetPlan.mockResolvedValueOnce({ planCode: 'payg', planId: 'p', subscriptionId: 's' });
    mockDeduct
      .mockRejectedValueOnce(new InsufficientFlowsError(0, 3))
      .mockResolvedValueOnce({ balanceAfter: 97 });
    mockTopup.mockResolvedValueOnce({ success: true, purchaseId: 'p-1', balanceAfter: 100 });

    const handler = vi.fn(async (_req, res: ReturnType<typeof mockRes>) => { res.statusCode = 200; });
    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();
    await wrapped({ companyId: 'co-1' } as never, res as never);

    expect(handler).toHaveBeenCalledOnce();
    expect(mockDeduct).toHaveBeenCalledTimes(2);
    expect(res.headers['X-Flow-Balance-After']).toBe('97');
  });

  it('refunds when handler throws', async () => {
    mockGetPlan.mockResolvedValueOnce({ planCode: 'payg', planId: 'p', subscriptionId: 's' });
    mockDeduct.mockResolvedValueOnce({ balanceAfter: 97 });
    mockRefund.mockResolvedValueOnce({ balanceAfter: 100 });

    const handler = vi.fn(async () => { throw new Error('boom'); });
    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();

    await expect(wrapped({ companyId: 'co-1' } as never, res as never)).rejects.toThrow('boom');
    expect(mockRefund).toHaveBeenCalledWith('co-1', 3, 'invoice.create', null);
    expect(res.headers['X-Flow-Refunded']).toBe('true');
    // Nudge should NOT be recalculated on error — we already refunded.
    await Promise.resolve();
    expect(mockNudge).not.toHaveBeenCalled();
  });

  it('refunds when handler responds with 4xx', async () => {
    mockGetPlan.mockResolvedValueOnce({ planCode: 'payg', planId: 'p', subscriptionId: 's' });
    mockDeduct.mockResolvedValueOnce({ balanceAfter: 97 });
    mockRefund.mockResolvedValueOnce({ balanceAfter: 100 });

    const handler = vi.fn(async (_req, res: ReturnType<typeof mockRes>) => { res.statusCode = 422; });
    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();
    await wrapped({ companyId: 'co-1' } as never, res as never);

    expect(mockRefund).toHaveBeenCalledOnce();
    expect(res.headers['X-Flow-Refunded']).toBe('true');
  });

  it('does NOT refund on 2xx / 3xx', async () => {
    mockGetPlan.mockResolvedValueOnce({ planCode: 'payg', planId: 'p', subscriptionId: 's' });
    mockDeduct.mockResolvedValueOnce({ balanceAfter: 97 });

    const handler = vi.fn(async (_req, res: ReturnType<typeof mockRes>) => { res.statusCode = 201; });
    const wrapped = withFlowMeter('invoice.create', 3)(handler);
    const res = mockRes();
    await wrapped({ companyId: 'co-1' } as never, res as never);

    expect(mockRefund).not.toHaveBeenCalled();
  });
});
