import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withExtensionToken: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ daily_tx_cap: 500, used: 0 }]) }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_r: unknown, data: unknown) => ({ kind: 'success', data })),
    validationError: vi.fn((_r: unknown, e: unknown) => ({ kind: 'validation', e })),
    tooManyRequests: vi.fn((_r: unknown, m: string) => ({ kind: '429', m })),
    conflict: vi.fn((_r: unknown, m: string) => ({ kind: '409', m })),
    badRequest: vi.fn((_r: unknown, m: string) => ({ kind: '400', m })),
    methodNotAllowed: vi.fn(() => ({ kind: '405' })),
  },
}));
const ingest = vi.fn();
vi.mock('@/modules/accounting/services/bank/feed/bankIngestionService', () => ({ ingestBankBatch: (...a: unknown[]) => ingest(...a) }));

import { BankIngestionRefusal } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';
import { contentHashIdentity } from '@/modules/accounting/services/bank/feed/bankIngestionValidation';
import { sql } from '@/lib/neon';
import handler from '../../../pages/api/accounting/bank-feeds/[id]/extension-ingest';

const sqlMock = vi.mocked(sql);

/**
 * Mutation-proof scoping check: finds the interpolated value that sits right
 * after a `company_id = ` (or `company_id=`) fragment in the tagged template
 * and asserts it is the expected company id. Fails if the WHERE clause loses
 * its `company_id` predicate, or if the predicate's value stops being the
 * request's own companyId.
 */
function expectCompanyScoped(call: [TemplateStringsArray, ...unknown[]], companyId: string) {
  const [strings, ...values] = call;
  const idx = strings.findIndex((s, i) => i < strings.length - 1 && /company_id\s*=\s*$/.test(s));
  expect(idx, `no "company_id = " fragment found in call: ${strings.join('?')}`).toBeGreaterThanOrEqual(0);
  expect(values[idx]).toBe(companyId);
}

const body = {
  scraperId: 'absa', scraperVersion: '1.2.0', bankAccountExternalId: '4051234567',
  fromDate: '2026-09-01', toDate: '2026-09-10',
  transactions: [{ transactionDate: '2026-09-02', amount: -50, description: 'ABSA FEE' }],
};
const req = (b: unknown = body) => ({
  method: 'POST', query: { id: 'conn-1' }, body: b,
  extension: { userId: 'u1', companyId: 'c1', connectionId: 'conn-1', bankId: 'absa', bankAccountId: 'gl-1' },
}) as never;

beforeEach(() => { ingest.mockReset(); sqlMock.mockClear(); });

describe('POST extension-ingest', () => {
  it('submits a content-hash feed batch and keeps the extension response shape', async () => {
    ingest.mockResolvedValue({ logId: 'l', importBatchId: 'b', appliedSuggestions: 1, warnings: [],
      counts: { found: 1, inserted: 1, updated: 0, duplicate: 0, pending: 0, removed: 0, conflicts: 0, ignored: 0 } });
    const out = await handler(req(), {} as NextApiResponse) as { kind: string; data: Record<string, unknown> };
    expect(out.kind).toBe('success');
    expect(out.data).toMatchObject({ found: 1, imported: 1, duplicate: 0, appliedRules: 1, warnings: [] });
    const [companyId, batch, opts] = ingest.mock.calls[0]!;
    expect(companyId).toBe('c1');
    expect(batch.source).toEqual({ kind: 'feed', connectionId: 'conn-1' });
    expect(batch.transactions[0]).toMatchObject({
      state: 'posted', currency: 'ZAR',
      identity: contentHashIdentity({ transactionDate: '2026-09-02', amount: -50, description: 'ABSA FEE' }),
    });
    expect(opts).toEqual({ userId: 'u1', sourceLabel: 'extension/absa@1.2.0', bankFormat: 'absa', dailyCap: 500 });

    // The daily cap is decided by the service under the lease (A-6), so the
    // route's only SQL is the post-success scraper_version UPDATE, which must
    // carry the request's own company_id.
    expect(sqlMock.mock.calls.length).toBe(1);
    for (const call of sqlMock.mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>) {
      expectCompanyScoped(call, 'c1');
    }
  });

  it('answers 409 when a sync is already running', async () => {
    ingest.mockRejectedValue(new BankIngestionRefusal('SYNC_IN_PROGRESS', 'A sync for this connection is already running.'));
    const out = await handler(req(), {} as NextApiResponse) as { kind: string };
    expect(out.kind).toBe('409');
  });

  it('answers 429 with the service message when the daily cap would be exceeded (A-6)', async () => {
    ingest.mockRejectedValue(new BankIngestionRefusal('DAILY_CAP_EXCEEDED', 'Daily transaction cap of 500 would be exceeded.'));
    const out = await handler(req(), {} as NextApiResponse) as { kind: string; m: string };
    expect(out).toEqual({ kind: '429', m: 'Daily transaction cap of 500 would be exceeded.' });
  });

  it('rejects a valueDate that is not YYYY-MM-DD before ingesting (A-7)', async () => {
    const bad = { ...body, transactions: [{ ...body.transactions[0], valueDate: 'x'.repeat(300) }] };
    const out = await handler(req(bad), {} as NextApiResponse) as { kind: string };
    expect(out.kind).toBe('validation');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('answers 400 for any other refusal so the failed log commits', async () => {
    ingest.mockRejectedValue(new BankIngestionRefusal('INVALID_TRANSACTION', 'Transaction 1: bad'));
    const out = await handler(req(), {} as NextApiResponse) as { kind: string; m: string };
    expect(out).toEqual({ kind: '400', m: 'Transaction 1: bad' });
  });

  it('lets a fault through (withErrorHandler answers 500, withExtensionToken ROLLBACKs)', async () => {
    ingest.mockRejectedValue(new Error('boom'));
    await expect(handler(req(), {} as NextApiResponse)).rejects.toThrow('boom');
  });
});
