/**
 * A FAULT inside the bank-rule sweep must reach withErrorHandler as a 500 at
 * every caller, so withAuth rolls the request back. applyRules counts every
 * refusal per line and returns; what escapes it is a coding defect, a pg
 * error or a poisoned request. Each of these three routes used to catch it —
 * two into a 200 with appliedRules 0, one into a 400 — which COMMITTED the
 * lines posted before the fault (withAuth rolls back only on >=500), reported
 * a partial run as a result, and left the sweep dead for the account without
 * a trace in Bugsink.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
  withExtensionToken: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => null) }));
vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: vi.fn(), refundFlows: vi.fn(), triggerAutoTopup: vi.fn(), recalculateNudge: vi.fn(), InsufficientFlowsError: class extends Error {},
}));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 1 }));
vi.mock('@/modules/accounting/services/bank/bankStatementParseService', () => ({
  parseStatement: vi.fn(async () => ({ transactions: [{ transactionDate: '2026-09-09', amount: -10, description: 'X' }], errors: [] })),
}));
vi.mock('@/modules/accounting/services/bank/bankBulkCommitDedupe', () => ({
  dedupeParsedTransactions: vi.fn(async (_c: string, _b: string, txs: unknown[]) => ({ dedupedTxs: txs, duplicateCount: 0 })),
}));
vi.mock('@/modules/accounting/services/bank/bankImportService', () => ({
  importParsedTransactions: vi.fn(async () => ({ batchId: 'batch', transactionCount: 1, errors: [], pendingTransfers: [] })),
}));
vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  applyRules: vi.fn(), deleteRule: vi.fn(), deleteRules: vi.fn(), toggleRule: vi.fn(), updateRule: vi.fn(),
}));
vi.mock('@/modules/accounting/utils/bankAccountNumberMatch', () => ({ compareBankAccountNumbers: () => 'inconclusive' }));

import { sql } from '@/lib/neon';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesService';
import rulesAction from '../../../pages/api/accounting/bank-rules-action';
import bulkCommit from '../../../pages/api/accounting/bank-transactions-bulk-commit';
import extensionIngest from '../../../pages/api/accounting/bank-feeds/[id]/extension-ingest';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const USER = '99999999-9999-4999-8999-999999999999';
const FAULT = new TypeError("Cannot read properties of undefined (reading 'id')");

function reqRes(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const req = { method: 'POST', query: { id: 'conn' }, body, companyId: COMPANY, user: { id: USER }, ...extra } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; }, status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; }, send(payload: unknown) { this.sent = payload; return this; }, end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

beforeEach(() => {
  vi.mocked(applyRules).mockReset();
  vi.mocked(sql).mockReset();
  vi.mocked(sql).mockResolvedValue([] as never);
});

describe('a sweep fault propagates — nothing answers 200 or 400 over a partial run', () => {
  it('bank-rules-action apply rethrows', async () => {
    vi.mocked(applyRules).mockRejectedValue(FAULT);
    const { req, res } = reqRes({ action: 'apply', bankAccountId: BANK });
    await expect(rulesAction(req, res)).rejects.toBe(FAULT);
    expect(res.statusCode).toBe(0);
  });

  it('bank-rules-action still answers other actions\' refusals as 400', async () => {
    const { toggleRule } = await import('@/modules/accounting/services/bank/bankRulesService');
    vi.mocked(toggleRule).mockRejectedValue(new Error('Rule not found'));
    const { req, res } = reqRes({ action: 'toggle', id: BANK });
    await rulesAction(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('bank-transactions-bulk-commit rethrows, so the file import rolls back with it', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ bank_account_number: null }] as never);
    vi.mocked(applyRules).mockRejectedValue(FAULT);
    const { req, res } = reqRes({
      bankAccountId: BANK, bulkImportId: '33333333-3333-4333-8333-333333333333', bulkSequence: 1, filename: 'a.csv',
      fileType: 'csv', bankFormat: 'generic', statementDate: '2026-09-09', csvContent: 'Date,Description,Amount\n2026-09-09,X,-10\n', applyBankRules: true,
    });
    await expect(bulkCommit(req, res)).rejects.toBe(FAULT);
    expect(res.statusCode).toBe(0);
  });

  it('extension-ingest asks for suggestions only (no control principal) and rethrows a fault', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ daily_tx_cap: 1000 }] as never)
      .mockResolvedValueOnce([{ used: 0 }] as never)
      .mockResolvedValueOnce([{ id: 'log' }] as never)
      .mockResolvedValue([] as never);
    vi.mocked(applyRules).mockRejectedValue(FAULT);
    const { req, res } = reqRes({
      scraperId: 'absa', scraperVersion: '1.0', bankAccountExternalId: 'ACC-1', fromDate: '2026-09-01', toDate: '2026-09-30',
      transactions: [{ transactionDate: '2026-09-09', amount: -10, description: 'X' }],
    }, { extension: { userId: USER, companyId: COMPANY, connectionId: 'conn', bankAccountId: BANK, bankId: 'absa' } });
    await expect(extensionIngest(req, res)).rejects.toBe(FAULT);
    expect(vi.mocked(applyRules).mock.calls[0]).toEqual([COMPANY, BANK, USER, undefined, { autoPost: false }]);
    expect(res.statusCode).toBe(0);
  });
});
