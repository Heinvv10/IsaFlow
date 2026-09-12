/**
 * What actually happens to an extension ingest whose rule pass faults: the
 * REAL withErrorHandler answers 500 and RETURNS (it does not rethrow), and
 * withExtensionToken has no status check, so it COMMITs the imported rows
 * and the sync log the handler marked 'failed'. Kept deliberately — rows are
 * not lost, the log says failed, a retry dedupes — but it must be seen, not
 * assumed: the sibling fault-propagation test mocks both wrappers to identity
 * and cannot tell a 500 response from a rollback.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), withScope: (fn: (s: unknown) => void) => fn({ setTag: vi.fn(), setContext: vi.fn(), setUser: vi.fn() }) }));
// Only the token wrapper is identity here; the error handler is the real one.
vi.mock('@/lib/auth', () => ({ withExtensionToken: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/bank/bankImportService', () => ({
  importParsedTransactions: vi.fn(async () => ({ batchId: 'batch', transactionCount: 1, errors: [], pendingTransfers: [] })),
}));
vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({ applyRules: vi.fn() }));

import { sql } from '@/lib/neon';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesService';
import extensionIngest from '../../../pages/api/accounting/bank-feeds/[id]/extension-ingest';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const USER = '99999999-9999-4999-8999-999999999999';

describe('extension-ingest: a rule-pass fault answers 500, and the wrapper returns rather than throwing', () => {
  it('responds 500 from withErrorHandler and marks the sync log failed — what withExtensionToken then commits', async () => {
    const statements: string[] = [];
    vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
      const text = strings.join('');
      statements.push(text);
      if (text.includes('daily_tx_cap')) return [{ daily_tx_cap: 1000 }];
      if (text.includes('transactions_imported')) return [{ used: 0 }];
      if (text.includes("'running'")) return [{ id: 'log' }];
      return [];
    }) as never);
    vi.mocked(applyRules).mockRejectedValue(new TypeError('boom'));
    const req = {
      method: 'POST', query: { id: 'conn' }, headers: {}, url: '/api/accounting/bank-feeds/conn/extension-ingest',
      body: { scraperId: 'absa', scraperVersion: '1.0', bankAccountExternalId: 'ACC-1', fromDate: '2026-09-01', toDate: '2026-09-30',
        transactions: [{ transactionDate: '2026-09-09', amount: -10, description: 'X' }] },
      extension: { userId: USER, companyId: COMPANY, connectionId: 'conn', bankAccountId: BANK, bankId: 'absa' },
    } as unknown as NextApiRequest;
    const res = {
      statusCode: 0, sent: undefined as unknown, headersSent: false,
      setHeader() { return this; }, getHeader() { return undefined; },
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { this.sent = payload; this.headersSent = true; return this; },
      send(payload: unknown) { this.sent = payload; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; },
      on() { return this; },
    };

    // Resolves — does not reject — so the token wrapper's COMMIT runs afterwards.
    await expect(extensionIngest(req, res as unknown as NextApiResponse)).resolves.not.toThrow();
    expect(res.statusCode).toBe(500);
    expect(statements.some(text => text.includes("status = 'failed'") && text.includes('bank_feed_sync_logs'))).toBe(true);
  });
});
