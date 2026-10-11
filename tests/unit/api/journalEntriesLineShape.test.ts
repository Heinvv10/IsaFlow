/**
 * POST /api/accounting/journal-entries (PR #688 round 5): the body is whatever the caller sent. A line that is not an
 * object, or a `costCenterId` that is not a string, answered 400 with the TypeError it caused further down
 * ("costCenterId.toLowerCase is not a function"). Both are named now, before anything is read or written. And the
 * documented `warnings` field (JournalEntryCreateResponse) is on the answer when a pick was not applied, absent otherwise.
 */
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

const OLD = 'aaaaaaaa-0000-4000-8000-000000000005';
const FT = 'aaaaaaaa-0000-4000-8000-000000000001';
async function post(lines: unknown[]) {
  const res = { statusCode: 200, status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return this; }),
    json: vi.fn(), setHeader: vi.fn() };
  const req = { method: 'POST', companyId: 'c1', user: { id: 'u1' }, body: { entryDate: '2026-06-01', lines } };
  await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req as never, res as never);
  return { status: res.statusCode, body: res.json.mock.calls[0]?.[0] as { data?: Record<string, unknown>; error?: { message?: string } } };
}
const good = { glAccountId: 'a', debit: 1, credit: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  createJournalEntry.mockResolvedValue({ id: 'je-1', status: 'draft' });
  sql.mockResolvedValue([
    { id: FT, code: 'FT', cc_type: 'cc1', is_active: true }, { id: OLD, code: 'OLD', cc_type: 'cc1', is_active: false },
  ]);
});

describe('journal-entries POST: the shape of `lines`', () => {
  it.each([
    ['null', [good, null], 'lines[1] must be a journal line object'],
    ['a string', ['x'], 'lines[0] must be a journal line object'],
    ['an array', [[good]], 'lines[0] must be a journal line object'],
    ['a pick sent as an array', [good, { ...good, costCenterId: [FT] }], 'lines[1].costCenterId must be a cost centre id (a string)'],
    ['a pick sent as a number', [{ ...good, costCenterId: 7 }], 'lines[0].costCenterId must be a cost centre id (a string)'],
    ['a pick sent as an object', [{ ...good, costCenterId: { id: FT } }], 'lines[0].costCenterId must be a cost centre id (a string)'],
  ])('%s: 400 naming the line, nothing read or written', async (_what, lines, message) => {
    const out = await post(lines);
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain(message);
    expect(JSON.stringify(out.body)).not.toMatch(/is not a function|Cannot read properties/);
    expect(sql).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('a null or absent pick is no pick', async () => {
    const out = await post([{ ...good, costCenterId: null }, good]);
    expect(out.status).toBe(200);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('journal-entries POST: `warnings` (JournalEntryCreateResponse)', () => {
  it('names a pick that was not applied, and the entry is created without it', async () => {
    const out = await post([{ ...good, costCenterId: OLD }, good]);
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({
      id: 'je-1', status: 'draft',
      warnings: ['Line 1: cost centre OLD is inactive and was not applied — the line posts without it.'],
    });
    expect((createJournalEntry.mock.calls[0]![1] as { lines: unknown[] }).lines).toEqual([good, good]);
  });

  it('is absent when every pick landed', async () => {
    const out = await post([{ ...good, costCenterId: FT }, good]);
    expect(out.body.data).toEqual({ id: 'je-1', status: 'draft' });
    expect((createJournalEntry.mock.calls[0]![1] as { lines: unknown[] }).lines).toEqual([{ ...good, cc1Id: FT }, good]);
  });
});
