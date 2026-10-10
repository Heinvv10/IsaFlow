/**
 * bank/bankTransferService (Banking > Transfers through the journal funnel, 2026-10-08): the legs, the refusals, the
 * manual-journal hold (draft + request, step-2 decision 6) and their order, pinned without a database (the
 * integration files bank-transfers-revive and bank-transfers-approval skip on GitHub).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sql, createJournalEntry, postJournalEntry, newManualJournalGate, markManualJournal, requestApproval,
  assertNotImpersonating, findRecorded,
} = vi.hoisted(() => ({
  sql: vi.fn(), createJournalEntry: vi.fn(), postJournalEntry: vi.fn(), newManualJournalGate: vi.fn(),
  markManualJournal: vi.fn(), requestApproval: vi.fn(), assertNotImpersonating: vi.fn(), findRecorded: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry, postJournalEntry }));
vi.mock('@/modules/accounting/services/gl/manualJournalApproval', () => ({ newManualJournalGate, markManualJournal }));
vi.mock('@/modules/accounting/services/gl/approvalDocuments', () => ({ requestApproval }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating }));
vi.mock('@/modules/accounting/services/bank/transferDuplicateGuard', () => ({ findTransferRecordedFromStatement: findRecorded }));

import {
  BankTransferRefusedError, PossibleDuplicateTransferError, postBankTransfer,
} from '@/modules/accounting/services/bank/bankTransferService';

const CO = 'c0000000-0000-4000-8000-000000000001';
const FROM = 'a0000000-0000-4000-8000-000000000001';
const TO = 'a0000000-0000-4000-8000-000000000002';
const accounts = (fromSubtype = 'bank', toSubtype = 'bank_account') => [
  { id: FROM, account_name: 'Cheque', account_subtype: fromSubtype },
  { id: TO, account_name: 'Savings', account_subtype: toSubtype },
];
const input = { fromAccountId: FROM, toAccountId: TO, amount: 250.5, transferDate: '2026-03-10' };

beforeEach(() => {
  vi.clearAllMocks();
  sql.mockResolvedValue(accounts());
  assertNotImpersonating.mockResolvedValue(undefined);
  findRecorded.mockResolvedValue(null);
  newManualJournalGate.mockResolvedValue({ enforced: false, held: false });
  markManualJournal.mockResolvedValue(undefined);
  requestApproval.mockResolvedValue({ id: 'req1', requiredRole: 'admin' });
  createJournalEntry.mockResolvedValue({ id: 'draft1' });
  postJournalEntry.mockResolvedValue({ id: 'draft1', status: 'posted', entryNumber: 'JE-2026-00001' });
});

describe('postBankTransfer', () => {
  it('creates one journal: DR the destination, CR the source, then posts that draft', async () => {
    const out = await postBankTransfer(CO, input, 'u1');
    expect(createJournalEntry).toHaveBeenCalledTimes(1);
    const [company, entry, user] = createJournalEntry.mock.calls[0]!;
    expect(company).toBe(CO);
    expect(user).toBe('u1');
    expect(entry).toMatchObject({
      entryDate: '2026-03-10', source: 'auto_bank_transfer', reference: 'Transfer: Cheque -> Savings',
      description: 'Transfer: Cheque -> Savings',
      lines: [
        { glAccountId: TO, debit: 250.5, credit: 0 },
        { glAccountId: FROM, debit: 0, credit: 250.5 },
      ],
    });
    expect(postJournalEntry).toHaveBeenCalledWith(CO, 'draft1', 'u1');
    expect(out).toMatchObject({ status: 'posted', fromName: 'Cheque', toName: 'Savings', entry: { status: 'posted' } });
    expect(markManualJournal).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("the user's reference is the description; the reference column keeps the transfer label", async () => {
    await postBankTransfer(CO, { ...input, reference: 'Move to savings' }, 'u1');
    expect(createJournalEntry.mock.calls[0]![1]).toMatchObject({ description: 'Move to savings', reference: 'Transfer: Cheque -> Savings' });
  });

  it.each([
    ['a missing account', () => sql.mockResolvedValueOnce([accounts()[0]]), /not found/],
    ['a non-bank destination', () => sql.mockResolvedValueOnce(accounts('bank', 'vat_input')), /both accounts must be bank accounts/],
    ['a non-bank source', () => sql.mockResolvedValueOnce(accounts(null as never, 'bank')), /both accounts must be bank accounts/],
  ])('%s is refused before the gate and before any journal', async (_label, arrange, message) => {
    arrange();
    const err = await postBankTransfer(CO, input, 'u1').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BankTransferRefusedError);
    expect(String((err as Error).message)).toMatch(message);
    expect(newManualJournalGate).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  // Hein, step-2 decision 6: held, not refused — the same draft, marked, with a request raised as the person.
  it('a matching manual-journal rule holds it: the draft is marked, a request raised as the person, nothing posted', async () => {
    newManualJournalGate.mockResolvedValueOnce({ enforced: true, held: true });
    const out = await postBankTransfer(CO, input, 'u1');
    expect(newManualJournalGate).toHaveBeenCalledWith(CO, [
      expect.objectContaining({ glAccountId: TO, debit: 250.5, credit: 0 }),
      expect.objectContaining({ glAccountId: FROM, debit: 0, credit: 250.5 }),
    ]);
    // Decided from reads before the draft exists; marked before the request is raised.
    expect(newManualJournalGate.mock.invocationCallOrder[0]!).toBeLessThan(createJournalEntry.mock.invocationCallOrder[0]!);
    expect(createJournalEntry.mock.calls[0]![1]).toMatchObject({ source: 'auto_bank_transfer', reference: 'Transfer: Cheque -> Savings' });
    expect(markManualJournal).toHaveBeenCalledWith(CO, 'draft1');
    expect(requestApproval).toHaveBeenCalledWith(CO, { documentType: 'manual_journal', documentId: 'draft1', requestedBy: 'u1' });
    expect(markManualJournal.mock.invocationCallOrder[0]!).toBeLessThan(requestApproval.mock.invocationCallOrder[0]!);
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: 'awaiting_approval', requestId: 'req1', requiredRole: 'admin', entry: { id: 'draft1' } });
  });

  it('enforced but below every rule: posted at once, not marked, no request (as before decision 6)', async () => {
    newManualJournalGate.mockResolvedValueOnce({ enforced: true, held: false });
    const out = await postBankTransfer(CO, input, 'u1');
    expect(postJournalEntry).toHaveBeenCalledWith(CO, 'draft1', 'u1');
    expect(markManualJournal).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(out.status).toBe('posted');
  });

  it('a Login-as session is refused before anything is read or written (R-032 L5, sec-nrfa M1)', async () => {
    const refused = Object.assign(new Error('impersonating'), { name: 'ImpersonationForbiddenError' });
    assertNotImpersonating.mockRejectedValueOnce(refused);
    await expect(postBankTransfer(CO, input, 'u1')).rejects.toBe(refused);
    expect(sql).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  // rev-nrfa LOW-1: the statement already recorded this movement as a transfer — typing it again would double it.
  it('a movement the statement may already hold needs a confirmation: refused before the gate and any journal', async () => {
    findRecorded.mockResolvedValueOnce('JE-2026-00042');
    const err = await postBankTransfer(CO, input, 'u1').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PossibleDuplicateTransferError);
    expect((err as PossibleDuplicateTransferError).existingEntryNumber).toBe('JE-2026-00042');
    expect(findRecorded).toHaveBeenCalledWith(CO, FROM, TO, 250.5, '2026-03-10');
    expect(newManualJournalGate).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('with confirmDuplicate the check is skipped and the transfer posts', async () => {
    findRecorded.mockResolvedValue('JE-2026-00042');
    await postBankTransfer(CO, { ...input, confirmDuplicate: true }, 'u1');
    expect(findRecorded).not.toHaveBeenCalled();
    expect(postJournalEntry).toHaveBeenCalledTimes(1);
    expect(BankTransferRefusedError).toBeDefined();
  });
});
