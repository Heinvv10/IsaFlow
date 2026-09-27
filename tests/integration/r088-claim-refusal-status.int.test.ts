// R-088 round 3: a receipt route answers the CLAIM's own content refusal with
// a 409, as the invoice routes do.
//
// The receipt check normally refuses first, under the same lock, so the
// claim's refusal is the backstop answer. To reach it, the check is replaced
// here by one that clears everything; the claim, its query and the route's
// answer are the production code.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/capture/receiptDuplicateGuard', () => ({
  checkReceiptDuplicate: vi.fn(async () => ({
    kind: 'clear', fingerprint: { receiptKey: null, duplicateOf: null, confirmedBy: null },
  })),
}));

import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import postExpenseRoute from '../../pages/api/accounting/capture/[id]/post-expense';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  accounts, call, claimLineCount, employee, errorOf, journalCount, pool, postedAt, purge, seed, upload,
  uploadToInbox, company, type Result,
} from './r088-receipt-content-dedupe.helpers';

assertDisposable();

const receiptToJournal = (documentId: string) =>
  call(receiptRoute, '/api/accounting/receipt-to-journal', { documentId });
const postExpense = (eventId: string, body: Record<string, unknown>) =>
  call(postExpenseRoute, `/api/accounting/capture/${eventId}/post-expense`, body, eventId);

function expectClaimConflict(result: Result) {
  expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(409);
  expect(errorOf(result).message).toMatch(/same file was already posted/i);
}

beforeAll(seed);
afterAll(async () => {
  try { await purge(); } finally { clearSystemAccountCache(); await pool.end(); }
}, 60_000);

describe('R-088 the claim content refusal on the receipt routes', () => {
  it('answers 409 on receipt-to-journal and both post-expense branches, writing nothing', async () => {
    const first = await upload('status-4370', { total: 4370 });
    expect((await receiptToJournal(first)).state.statusCode).toBe(200);

    const copy = await upload('status-4370', { total: 4370 });
    expectClaimConflict(await receiptToJournal(copy));
    expect(await journalCount([copy])).toBe(0);

    const petty = await uploadToInbox('status-4370', { total: 4370 });
    expectClaimConflict(await postExpense(petty.eventId, { glAccountId: accounts[company]!.office }));
    expect(await journalCount([petty.documentId])).toBe(0);

    const claim = await uploadToInbox('status-4370', { total: 4370 });
    expectClaimConflict(await postExpense(claim.eventId, { employeeId: employee, glAccountId: accounts[company]!.office }));
    expect(await claimLineCount(claim.documentId)).toBe(0);
    expect(await postedAt(claim.documentId)).toBeNull();
  });
});
