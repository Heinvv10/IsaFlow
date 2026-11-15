/**
 * Which route reaches the draft cancel. Real route handlers and REAL services over a scripted sql and row lock:
 *  - credit-notes-action `cancel_draft` cancels a draft (no journal write) and REFUSES a note that is not a draft
 *    under the lock, without reversing anything;
 *  - credit-notes-action `cancel` and supplier-credit-notes PATCH `reverse` keep refusing a draft, so the draft path
 *    is reachable only by the explicit draft intent (a stale "Cancel draft" page can never reverse a posted note,
 *    and a "reverse" can never quietly void a draft).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(), respondIfImpersonationForbidden: () => false }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rowLockBudget', () => ({
  underFlowLockBudget: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({ lockCreditNoteForUpdate: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteService')>()),
  getCreditNoteById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(), postJournalEntry: vi.fn(), reverseJournalEntry: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { getCreditNoteById } from '@/modules/accounting/services/ar/creditNoteService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import actionHandler from '../../../pages/api/accounting/credit-notes-action';
import supplierHandler from '../../../pages/api/accounting/supplier-credit-notes';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';
const note = (status: string) => ({ id: NOTE, credit_note_number: 'CN-1', type: 'supplier', status, applied_amount: '0', gl_journal_entry_id: status === 'draft' ? null : 'je-1' });

function call(handler: unknown, method: string, body: Record<string, unknown>) {
  const res = {
    statusCode: 200, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  const req = { method, body, query: {}, headers: {}, user: { id: '33333333-3333-4333-8333-333333333333' }, companyId: COMPANY };
  return (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req as never, res as never).then(() => res);
}
const statements = () => vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?').replace(/\s+/g, ' ').trim());
const updatedNote = () => statements().some((s) => /^UPDATE credit_notes/.test(s));

beforeEach(() => {
  vi.mocked(sql).mockReset();
  vi.mocked(reverseJournalEntry).mockReset();
  vi.mocked(lockCreditNoteForUpdate).mockReset();
  vi.mocked(getCreditNoteById).mockReset();
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const s = strings.join('?');
    if (/credit_note_allocations/.test(s)) return [{ n: 0 }];
    if (/UPDATE credit_notes/.test(s)) return [{ id: NOTE, credit_note_number: 'CN-1', type: 'supplier', status: 'cancelled' }];
    return [];
  }) as never);
});

describe('credit-notes-action cancel_draft', () => {
  it('cancels a draft: one UPDATE, no journal reversed', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note('draft') as never);
    const res = await call(actionHandler, 'POST', { action: 'cancel_draft', creditNoteId: NOTE });
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe('cancelled');
    expect(updatedNote()).toBe(true);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it.each(['approved', 'partially_applied', 'applied'])('a note that is %s by the time of the click is refused with a 400 and NOTHING is reversed or written', async (status) => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note(status) as never);
    const res = await call(actionHandler, 'POST', { action: 'cancel_draft', creditNoteId: NOTE });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('not a draft');
    expect(updatedNote()).toBe(false);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });
});

describe('the generic cancel and reverse keep refusing a draft', () => {
  it('credit-notes-action cancel on a draft: 400 with the old message, nothing written', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note('draft') as never);
    const res = await call(actionHandler, 'POST', { action: 'cancel', creditNoteId: NOTE });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Cannot cancel credit note with status: draft');
    expect(updatedNote()).toBe(false);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('supplier-credit-notes PATCH reverse on a draft: refused (rolled back, not a 2xx), the draft is not cancelled', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue({ id: NOTE, type: 'supplier', status: 'draft' } as never);
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note('draft') as never);
    const res = await call(supplierHandler, 'PATCH', { id: NOTE, action: 'reverse' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(updatedNote()).toBe(false);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });
});
