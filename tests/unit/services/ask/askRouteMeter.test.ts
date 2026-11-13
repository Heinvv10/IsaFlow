// "Ask IsaFlow" is metered like the report its figure comes from: profit, revenue and expenses as report.pnl,
// assets and liabilities as report.bs; everything else is free. Real withFlowMeter, mocked wallet.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ answer: vi.fn(), plan: vi.fn(), deduct: vi.fn(), refund: vi.fn(), topup: vi.fn(), provider: vi.fn(), providerOn: { value: false } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ask/askAnswer', () => ({ answerQuestion: m.answer }));
vi.mock('@/modules/accounting/services/ask/askProvider', () => ({ resolveProvider: () => (m.providerOn.value ? { answer: m.provider } : null) }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: m.plan }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn(), runAfterRollback: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: m.deduct, refundFlows: m.refund, triggerAutoTopup: m.topup, recalculateNudge: vi.fn().mockResolvedValue(undefined),
  InsufficientFlowsError: class InsufficientFlowsError extends Error {
    constructor(public balance: number, public required: number) { super('insufficient_flows'); }
  },
}));

import handler from '../../../../pages/api/accounting/ask';
import { InsufficientFlowsError } from '@/modules/billing/services/flowWalletService';
import { FLOW_OPERATIONS } from '@/modules/billing/services/flowOperationCatalog';

const fig = { understood: true, text: 'ok', figure: 12, lines: [], link: null, suggestions: [] };
const run = async (q: string, extra: Record<string, unknown> = {}, headersSent = false) => {
  const res = {
    statusCode: 200, headersSent,
    status(c: number) { this.statusCode = c; return this; }, json: vi.fn().mockReturnThis(), setHeader: vi.fn(),
  };
  await (handler as unknown as (a: unknown, b: unknown) => Promise<unknown>)({ method: 'GET', query: { q, ...extra }, companyId: 'co' }, res);
  return res;
};
const charged = () => m.deduct.mock.calls.map((c) => c[2]);

beforeEach(() => {
  vi.clearAllMocks();
  m.plan.mockResolvedValue({ planCode: 'payg' });
  m.deduct.mockResolvedValue({ balanceAfter: 90 });
  m.refund.mockResolvedValue({ balanceAfter: 100 });
  m.answer.mockResolvedValue(fig);
  m.providerOn.value = false;
  m.provider.mockReset();
  m.provider.mockResolvedValue(fig);
});

describe('metering', () => {
  it.each([
    ['what is my profit this month', 'report.pnl'], ['what is my revenue this year', 'report.pnl'], ['what are my expenses last month', 'report.pnl'],
    ['what are my total assets', 'report.bs'], ['what are my total liabilities', 'report.bs'],
  ])('%s charges %s once, at the catalogue rate', async (q, op) => {
    await run(q);
    expect(m.deduct).toHaveBeenCalledTimes(1);
    expect(m.deduct).toHaveBeenCalledWith('co', FLOW_OPERATIONS[op as 'report.pnl' | 'report.bs'].cost, op, null);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it.each([
    ['who owes me money'], ['who do I owe'], ['how much cash is in the bank'], ['how many bank transactions need allocating'],
    ['what vat do I owe'], ['what do I owe sars for payroll'], ['what did the last pay run cost'],
  ])('%s is free', async (q) => {
    await run(q);
    expect(m.deduct).not.toHaveBeenCalled();
  });

  it('an unrecognised, ambiguous, multi-period or unsupported-refinement question charges nothing', async () => {
    const qs = ['what is the weather', 'total assets and liabilities', 'profit this year vs last year', 'profit before tax', 'net profit vs last month', 'gross profit and net profit'];
    for (const q of qs) await run(q);
    expect(m.deduct).not.toHaveBeenCalled();
    expect(m.answer).toHaveBeenCalledTimes(qs.length);
  });

  it('a metered question that still returns no figure is refunded', async () => {
    m.answer.mockResolvedValue({ ...fig, figure: null });
    const res = await run('what is my profit this month');
    expect(charged()).toEqual(['report.pnl']);
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('X-Flow-Refunded', 'true');
  });

  it('a failing answer is refunded', async () => {
    m.answer.mockRejectedValue(new Error('boom'));
    await expect(run('what are my total assets')).rejects.toThrow('boom');
    expect(m.refund).toHaveBeenCalledTimes(1);
  });

  it('an insufficient balance answers 402 and computes nothing', async () => {
    m.deduct.mockRejectedValue(new InsufficientFlowsError(2, 10));
    m.topup.mockResolvedValue({ success: false });
    const res = await run('what is my profit this month');
    expect(res.statusCode).toBe(402);
    expect(m.answer).not.toHaveBeenCalled();
  });

  it('a non-PAYG company is not charged', async () => {
    m.plan.mockResolvedValue({ planCode: 'pro' });
    await run('what is my profit this month');
    expect(m.deduct).not.toHaveBeenCalled();
    expect(m.answer).toHaveBeenCalledTimes(1);
  });

  it.each([['what is my profit for 2025'], ['what is my profit in q3'], ['what are my total assets last year'], ['what are my total assets last quarter'], ['what are my expenses today'], ['what are my total assets as at 15 october 2027'], ['what are my total assets as at 29 february 2026'], ['what is my profit on 15 october']])(
    'a refused window (%s) is decided before any debit: no charge, no refund, no 402 path',
    async (q) => {
      m.deduct.mockRejectedValue(new InsufficientFlowsError(0, 10)); // a dry wallet must not matter
      const res = await run(q);
      expect(m.deduct).not.toHaveBeenCalled();
      expect(m.refund).not.toHaveBeenCalled();
      expect(m.topup).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(m.answer).toHaveBeenCalledTimes(1);
    },
  );

  it('mode=free never meters, even with a provider stubbed in and a metered question', async () => {
    m.providerOn.value = true;
    const res = await run('what is my profit this month', { mode: 'free' });
    expect(m.provider).toHaveBeenCalledTimes(1);
    expect(m.deduct).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('a no-figure answer is refunded even when the response is already flushed (headers cannot be set)', async () => {
    // A refused window that still reaches the meter would be one the pure check missed; the meter's own rule must hold.
    m.answer.mockResolvedValue({ ...fig, figure: null });
    const res = await run('what is my total assets', {}, true);
    expect(m.deduct).toHaveBeenCalledTimes(1);
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(res.setHeader).not.toHaveBeenCalledWith('X-Flow-Refunded', 'true');
  });
});
