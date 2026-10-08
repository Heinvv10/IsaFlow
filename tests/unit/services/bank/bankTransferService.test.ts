/**
 * bank/bankTransferService (Banking > Transfers through the journal funnel, 2026-10-08): the legs, the refusals and
 * their order, pinned without a database (the integration file bank-transfers-revive skips on GitHub).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sql, createJournalEntry, postJournalEntry, newManualJournalRefusal, assertNotImpersonating, findRecorded } =
  vi.hoisted(() => ({
    sql: vi.fn(), createJournalEntry: vi.fn(), postJournalEntry: vi.fn(), newManualJournalRefusal: vi.fn(),
    assertNotImpersonating: vi.fn(), findRecorded: vi.fn(),
  }));
vi.mock('@/lib/neon', () => ({ sql }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry, postJournalEntry }));
vi.mock('@/modules/accounting/services/gl/manualJournalApproval', () => ({ newManualJournalRefusal }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating }));
vi.mock('@/modules/accounting/services/bank/transferDuplicateGuard', () => ({ findTransferRecordedFromStatement: findRecorded }));

import { BankTransferRefusedError, postBankTransfer } from '@/modules/accounting/services/bank/bankTransferService';

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
  newManualJournalRefusal.mockResolvedValue(null);
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
    expect(out).toMatchObject({ fromName: 'Cheque', toName: 'Savings', entry: { status: 'posted' } });
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
    expect(newManualJournalRefusal).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('a matching manual-journal rule refuses it before any journal is created', async () => {
    const refusal = Object.assign(new Error('needs admin approval'), { name: 'ApprovalRequiredError' });
    newManualJournalRefusal.mockResolvedValueOnce(refusal);
    await expect(postBankTransfer(CO, input, 'u1')).rejects.toBe(refusal);
    expect(newManualJournalRefusal).toHaveBeenCalledWith(CO, 250.5, expect.any(Function));
    expect(createJournalEntry).not.toHaveBeenCalled();
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('a Login-as session is refused before anything is read or written (R-032 L5, sec-nrfa M1)', async () => {
    const refused = Object.assign(new Error('impersonating'), { name: 'ImpersonationForbiddenError' });
    assertNotImpersonating.mockRejectedValueOnce(refused);
    await expect(postBankTransfer(CO, input, 'u1')).rejects.toBe(refused);
    expect(sql).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  // rev-nrfa LOW-1: the statement already recorded this movement as a transfer — typing it again would double it.
  it('a movement already recorded from the statement is refused before the gate and before any journal', async () => {
    findRecorded.mockResolvedValueOnce('JE-2026-00042');
    const err = await postBankTransfer(CO, input, 'u1').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BankTransferRefusedError);
    expect(String((err as Error).message)).toMatch(/already in the ledger as JE-2026-00042/);
    expect(findRecorded).toHaveBeenCalledWith(CO, FROM, TO, 250.5, '2026-03-10');
    expect(newManualJournalRefusal).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });
});
