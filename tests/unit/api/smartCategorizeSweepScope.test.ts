/**
 * POST /api/accounting/smart-categorize keeps to the sweep scope (categorizeSweepScope.ts, decision 2):
 *  - the LLM residual pass after an account sweep looks at the sweep's own lines, never the whole account;
 *  - an explicit transactionIds request over the per-run cap is refused before anything runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(), smartCategorizeForAccount: vi.fn(), bulkCategorize: vi.fn(), getAutoPostSettings: vi.fn(),
  buildRunDeps: vi.fn(), runAfterCommit: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: async () => true }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: m.runAfterCommit }));
vi.mock('@/modules/accounting/services/core/smartCategorizationService', () => ({
  categorizeBankTransaction: vi.fn(), bulkCategorize: m.bulkCategorize,
  smartCategorizeForAccount: m.smartCategorizeForAccount, learnFromAllocation: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({
  sweep: vi.fn(), getAutoPostSettings: m.getAutoPostSettings,
}));
vi.mock('@/modules/accounting/services/bank/llmCategorizationPass', () => ({
  selectResidualTxIds: (rows: Array<{ id: string }>) => rows.map((r) => r.id),
  runLlmResidualPass: vi.fn(), buildRunDeps: m.buildRunDeps, MAX_LLM_CALLS_PER_RUN: 200,
}));

import handler from '../../../pages/api/accounting/smart-categorize';

const CO = '00000000-0000-4000-8000-000000000001';
const BANK = '00000000-0000-4000-8000-0000000000aa';

function res() {
  const r = { statusCode: 200, body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
const post = async (body: unknown) => {
  const out = res();
  await (handler as unknown as (q: unknown, s: unknown) => Promise<unknown>)(
    { method: 'POST', companyId: CO, user: { id: 'u1' }, body, query: {}, headers: {} }, out);
  return out;
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  delete process.env.CATEGORIZE_SWEEP_MAX_LINES;
  m.getAutoPostSettings.mockResolvedValue({ llmEnabled: true });
  m.buildRunDeps.mockResolvedValue({});
});

describe('account sweep', () => {
  it('the residual pass reads only the lines the sweep tried for the first time', async () => {
    m.smartCategorizeForAccount.mockResolvedValue({
      categorized: 1, skipped: 2,
      results: [{ transactionId: 't1', result: {} }, { transactionId: 't2', result: null }, { transactionId: 't3', result: null }],
      firstAttemptTxIds: ['t1', 't2'], // t3 was tried (and left unsuggested) by an earlier click
    });
    m.sql.mockImplementation(async (_s: TemplateStringsArray, ...vals: unknown[]) =>
      (vals[0] as string[]).map((id) => ({ id, status: 'imported', suggestedGlAccountId: null, suggestedConfidence: null })));
    const r = await post({ action: 'categorize', bankAccountId: BANK });
    expect(r.statusCode).toBe(200);
    expect(m.sql).toHaveBeenCalledTimes(1);
    const text = (m.sql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).not.toMatch(/bank_account_id/);
    expect(m.sql.mock.calls[0]![1]).toEqual(['t1', 't2']);
    expect(m.buildRunDeps).toHaveBeenCalledWith(CO, 'u1', ['t1', 't2']);
    expect((r.body as { data: Record<string, unknown> }).data).not.toHaveProperty('firstAttemptTxIds');
  });
});

describe('explicit transactionIds', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  it('over the cap (200): 400, nothing categorized', async () => {
    const r = await post({ action: 'categorize', transactionIds: ids(201) });
    expect(r.statusCode).toBe(400);
    expect(m.bulkCategorize).not.toHaveBeenCalled();
  });
  it('the cap follows CATEGORIZE_SWEEP_MAX_LINES', async () => {
    process.env.CATEGORIZE_SWEEP_MAX_LINES = '5';
    expect((await post({ action: 'categorize', transactionIds: ids(6) })).statusCode).toBe(400);
    expect(m.bulkCategorize).not.toHaveBeenCalled();
    delete process.env.CATEGORIZE_SWEEP_MAX_LINES;
  });
});
