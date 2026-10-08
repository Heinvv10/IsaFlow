/**
 * NUMRACE register (d) + brk-nrfd: the journal-entries POST never answers driver text. A Postgres error of class 22
 * (a value it cannot read) or 23 (a value a constraint refuses) is the caller's: 400, naming entryDate only for a date
 * (22007/22008). Any other driver error is the server's: rethrown to withErrorHandler's 500, which rolls back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { createJournalEntry } = vi.hoisted(() => ({ createJournalEntry: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry, getJournalEntries: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/manualJournalApproval', () => ({ markCreatedManualJournal: vi.fn() }));

import handler from '../../../pages/api/accounting/journal-entries';

const driverError = (code: string, message: string) => Object.assign(new Error(message), { code });
function call() {
  const res = { statusCode: 200, status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return this; }),
    json: vi.fn(), setHeader: vi.fn() };
  const req = { method: 'POST', companyId: 'c1', user: { id: 'u1' },
    body: { entryDate: '2026-06-01', lines: [{ glAccountId: 'a', debit: 1, credit: 0 }, { glAccountId: 'b', debit: 0, credit: 1 }] } };
  return { run: () => (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req as never, res as never), res };
}
const bodyOf = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0]);

beforeEach(() => { vi.clearAllMocks(); });

describe('journal-entries POST: driver errors', () => {
  it.each([
    ['22007', 'invalid input syntax for type date: "garbage"', /entryDate must be a real date/],
    ['22008', 'date/time field value out of range: "2026-02-30"', /entryDate must be a real date/],
    ['22P02', 'invalid input syntax for type uuid: "x"', /check its accounts, dimensions, amounts and descriptions/],
    ['23514', 'new row for relation "gl_journal_lines" violates check constraint "chk_debit_or_credit"', /check its accounts/],
    ['23503', 'insert or update on table "gl_journal_lines" violates foreign key constraint "fk_x"', /check its accounts/],
    ['23502', 'null value in column "x" of relation "gl_journal_lines" violates not-null constraint', /check its accounts/],
  ])('%s: 400, caller-safe wording, no driver text', async (code, message, wording) => {
    createJournalEntry.mockRejectedValueOnce(driverError(code, message));
    const { run, res } = call();
    await run();
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)).toMatch(wording);
    expect(bodyOf(res)).not.toContain(message.slice(0, 20));
    if (code !== '22007' && code !== '22008') expect(bodyOf(res)).not.toMatch(/entryDate/);
  });

  it('23505 (a clash with a row written at the same moment): 409, retry wording, no driver text', async () => {
    createJournalEntry.mockRejectedValueOnce(driverError('23505', 'duplicate key value violates unique constraint "uq_x"'));
    const { run, res } = call();
    await run();
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res)).toMatch(/try again/);
    expect(bodyOf(res)).not.toMatch(/duplicate key|uq_x/);
  });

  it.each(['XX000', '53300', '42703'])('%s (the server\'s): rethrown to the 500 that rolls back', async (code) => {
    createJournalEntry.mockRejectedValueOnce(driverError(code, 'column "x" does not exist'));
    const { run } = call();
    await expect(run()).rejects.toMatchObject({ code });
  });

  it('a refusal the service raised (no SQLSTATE) keeps its own wording as a 400', async () => {
    createJournalEntry.mockRejectedValueOnce(new Error('Invalid journal entry: Line 1: Debit and credit must be numbers'));
    const { run, res } = call();
    await run();
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)).toMatch(/must be numbers/);
  });
});
