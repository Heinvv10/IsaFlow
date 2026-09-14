/**
 * The petty-cash auto-post catch must swallow EVERY posting refusal, not only a
 * closed fiscal period.
 *
 * `assertPostingGuards` refuses three ways — a non-open period
 * (`ClosedFiscalPeriodError`), a company lockdown (`LOCKDOWN_REFUSAL_MESSAGE`)
 * and a filed VAT period (`VAT_PERIOD_REFUSAL_MESSAGE`) — and the route this
 * service was lifted out of answers all three by leaving the journal a draft.
 * Catching only the first class turned the other two into a 500 on a receipt
 * that had already been captured and claimed.
 *
 * The assertion is the OUTCOME (a draft journal, the event still stamped), not
 * the catch's source text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClosedFiscalPeriodError,
  LOCKDOWN_REFUSAL_MESSAGE,
  VAT_PERIOD_REFUSAL_MESSAGE,
} from '@/modules/accounting/services/gl/postingPeriodGuard';

const sql = vi.fn(async () => []);
const postJournalEntry = vi.fn(async () => undefined);

vi.mock('@/lib/neon', () => ({ sql: (...args: unknown[]) => sql(...(args as [])) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async () => 'bank-account-id'),
}));
vi.mock('@/modules/accounting/services/gl/inputVatDenial', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveVatCodeForAccount: vi.fn(async () => ({ denied: false, vatCode: 'S' })),
}));
vi.mock('@/modules/accounting/services/bank/receiptToJournalService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildExpenseJournalFromReceipt: vi.fn(() => ({
    description: 'Till slip',
    inputVatDenied: false,
    lines: [
      { accountId: 'expense-account', debit: 100, credit: 0, description: 'Expense', vatType: 'S' },
      { accountId: 'bank-account-id', debit: 0, credit: 100, description: 'Petty cash' },
    ],
  })),
  mealsVatNeedsAPerson: vi.fn(() => false),
  shouldAutoPostReceipt: vi.fn(() => true),
}));
vi.mock('@/modules/accounting/services/capture/captureRowLock', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimCapturedDocumentForPosting: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1', status: 'draft' })),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postJournalEntry: (...args: unknown[]) => postJournalEntry(...(args as [])),
}));

const { postReceiptAsPettyCashJournal } = await import(
  '@/modules/accounting/services/capture/pettyCashJournalService'
);

function run() {
  return postReceiptAsPettyCashJournal({
    companyId: 'company-1',
    userId: 'user-1',
    eventId: 'event-1',
    documentId: 'document-1',
    extracted: { date: '2026-03-31', vendorName: 'Corner Cafe', totalAmount: 100 } as never,
    resolvedGlAccountId: 'expense-account',
    vatInputAccountId: 'vat-input-account',
  });
}

describe('petty cash auto-post refusals', () => {
  beforeEach(() => {
    postJournalEntry.mockReset();
    postJournalEntry.mockResolvedValue(undefined);
  });

  it('leaves a draft when the period is closed', async () => {
    postJournalEntry.mockRejectedValue(new ClosedFiscalPeriodError('closed'));
    await expect(run()).resolves.toMatchObject({ journalEntry: { id: 'je-1', status: 'draft' } });
  });

  it('leaves a draft when the company is in lockdown', async () => {
    postJournalEntry.mockRejectedValue(new Error(LOCKDOWN_REFUSAL_MESSAGE));
    await expect(run()).resolves.toMatchObject({ journalEntry: { id: 'je-1', status: 'draft' } });
  });

  it('leaves a draft when the VAT period is filed', async () => {
    postJournalEntry.mockRejectedValue(new Error(VAT_PERIOD_REFUSAL_MESSAGE));
    await expect(run()).resolves.toMatchObject({ journalEntry: { id: 'je-1', status: 'draft' } });
  });

  it('still rethrows a fault that is not a posting refusal', async () => {
    postJournalEntry.mockRejectedValue(new Error('connection terminated unexpectedly'));
    await expect(run()).rejects.toThrow(/connection terminated/);
  });

  it('reports posted when nothing refuses', async () => {
    await expect(run()).resolves.toMatchObject({ journalEntry: { id: 'je-1', status: 'posted' } });
  });
});
