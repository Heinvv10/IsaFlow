/** POST /api/accounting/journal-entries refuses a sourceDocumentId whose upload is still being read (400), nothing written. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { createJournalEntry, sql } = vi.hoisted(() => ({ createJournalEntry: vi.fn(), sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));
vi.mock('@/lib/neon', () => ({ sql, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry, getJournalEntries: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/manualJournalApproval', () => ({ markCreatedManualJournal: vi.fn() }));

import handler from '../../../pages/api/accounting/journal-entries';

const DOC = 'dddddddd-0000-4000-8000-dddddddddddd';
const lines = [{ glAccountId: 'a', debit: 1, credit: 0 }, { glAccountId: 'b', debit: 0, credit: 1 }];
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

async function post() {
  const res = { statusCode: 200, status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return this; }),
    json: vi.fn(), setHeader: vi.fn() };
  const req = { method: 'POST', companyId: 'c1', user: { id: 'u1' }, body: { entryDate: '2026-06-01', sourceDocumentId: DOC, lines } };
  await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req as never, res as never);
  return { status: res.statusCode, body: res.json.mock.calls[0]?.[0] as { error?: { message?: string } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  createJournalEntry.mockResolvedValue({ id: 'je-1', status: 'draft' });
});

describe('journal-entries POST: sourceDocumentId and a document being read', () => {
  it('400s a document being read and creates nothing', async () => {
    sql.mockResolvedValue([{ read_state: 'reading', read_heartbeat_at: null, created_at: minutesAgo(1) }]);
    const out = await post();
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain('This document is still being read.');
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('accepts a document whose read went stale or finished', async () => {
    sql.mockResolvedValue([{ read_state: 'reading', read_heartbeat_at: null, created_at: minutesAgo(30) }]);
    expect((await post()).status).toBe(200);
    sql.mockResolvedValue([{ read_state: 'done', read_heartbeat_at: null, created_at: minutesAgo(1) }]);
    expect((await post()).status).toBe(200);
    expect(createJournalEntry).toHaveBeenCalledTimes(2);
  });

  it('still 400s a document that is not this company\'s', async () => {
    sql.mockResolvedValue([]);
    expect((await post()).status).toBe(400);
  });
});
