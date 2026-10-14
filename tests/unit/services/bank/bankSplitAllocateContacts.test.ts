/**
 * splitAllocateTransaction with SUPPLIER / CUSTOMER lines (bankSplitContacts.ts,
 * bankSplitJournal.ts): one bank line that settles two contacts, or a contact
 * and a GL account.
 *
 *   · a contact line posts to the AP/AR control account — no VAT, no dimensions —
 *     and its document is recorded AFTER the journal, on that journal, in the
 *     bank line's direction: payment / refund (supplier), receipt / refund (customer)
 *   · only the GL-account lines go through the dimension plan and the journal gates,
 *     and the journal gate judges the WHOLE line's amount
 *   · every refusal lands before the journal is created
 *
 * planSplitContacts' own refusals are in bankSplitContacts.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankLineJournalGate', () => ({ assertBankLineMayPostToAccounts: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/bankLinePaymentGate', () => ({
  assertBankLineMayPaySupplier: vi.fn(), isBankEvidenced: vi.fn(() => true),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(), assertSupplierInCompany: vi.fn(),
}));
vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return {
    sql: vi.fn(),
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(vi.fn().mockResolvedValue([]))),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => Promise.resolve().then(fn)),
    fmtDate: actual.fmtDate,
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })), postJournalEntry: vi.fn(async () => ({})),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ resolveUserUuid: vi.fn(async (u: string) => u) }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async (kind: string) => (kind === 'payable' ? 'ap-1' : 'ar-1')),
}));
vi.mock('@/modules/accounting/services/bank/bankVatAccountResolver', () => ({ resolveVatAccountId: vi.fn(async () => 'vat-in') }));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({ mapTxRow: vi.fn((row: unknown) => row) }));
vi.mock('@/modules/accounting/services/bank/bankSplitDimensions', () => ({ planSplitDimensions: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({ lockBankTransactionForUpdate: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', () => ({
  assertImporterMayAllocate: vi.fn(), assertImporterMayAllocateAs: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierRefundDocument', () => ({ planSupplierRefund: vi.fn(), recordSupplierRefund: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerRefundDocument', () => ({ planCustomerRefund: vi.fn(), recordCustomerRefund: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierAutoAllocate', () => ({ recordSupplierBankPayment: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/customerAutoAllocate', () => ({ autoApplyCustomerReceipt: vi.fn() }));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { planSplitDimensions } from '@/modules/accounting/services/bank/bankSplitDimensions';
import { lockBankTransactionForUpdate } from '@/modules/accounting/services/bank/bankTxLock';
import { assertBankLineMayPostToAccounts } from '@/modules/accounting/services/bank/bankLineJournalGate';
import { assertImporterMayAllocate } from '@/modules/accounting/services/bank/bankLineImporterGate';
import { assertBankLineMayPaySupplier } from '@/modules/accounting/services/ap/bankLinePaymentGate';
import { recordSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { recordCustomerRefund } from '@/modules/accounting/services/ar/customerRefundDocument';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { autoApplyCustomerReceipt } from '@/modules/accounting/services/ar/customerAutoAllocate';
import { splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import type { SplitLine } from '@/modules/accounting/services/bank/bankAllocationTypes';
import { enterFakeRequestCtx } from '../../helpers/requestCtx';

const COMPANY = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const USER = '00000000-0000-0000-0000-000000000001';
const BANK = 'bank-acct';
const FRIK = '2c4b0a2e-1111-4111-8111-aaaaaaaaaaaa';
const SOUTHERN = '9f0d7c1a-2222-4222-8222-bbbbbbbbbbbb';
const CUST = '5e6f7a8b-3333-4333-8333-cccccccccccc';
const OUT = { id: 'tx-1', bank_account_id: BANK, amount: -1959.48, transaction_date: '2026-10-07', status: 'imported', feed_state: 'posted', description: 'Frik Basson', reference: 'SAGE1' };
const IN = { ...OUT, amount: 1959.48 };

type Line = { glAccountId: string; debit: number; credit: number; vatType?: string; cc1Id?: string; cc2Id?: string; buId?: string };
const postedLines = (): Line[] => (vi.mocked(createJournalEntry).mock.calls[0]![1] as { lines: Line[] }).lines;
const sqlText = () => vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));

/** The bank row the lock returns, and every SQL statement answered by what it reads — not by call order. */
function given(tx: typeof OUT): void {
  vi.mocked(lockBankTransactionForUpdate).mockResolvedValue(tx as never);
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('SELECT name FROM')) return [{ name: 'Contact' }];
    if (q.includes('INSERT INTO customer_payments')) return [{ id: 'rcpt-1' }];
    if (q.includes('SELECT jl.id FROM gl_journal_lines')) return [{ id: 'jl-bank' }];
    if (q.includes('SELECT * FROM bank_transactions')) return [tx];
    return [];
  }) as never);
  vi.mocked(planSplitDimensions).mockImplementation((async (_c: string, _b: string, lines: unknown[]) =>
    ({ dims: lines.map(() => ({})), warnings: [] })) as never);
}
const split = (lines: SplitLine[]) => splitAllocateTransaction(COMPANY, 'tx-1', lines, USER);

beforeEach(() => {
  vi.resetAllMocks();
  enterFakeRequestCtx();
});

describe('money out to two suppliers', () => {
  it('posts one AP line per supplier with no VAT or dimensions, then records each payment on the journal', async () => {
    given(OUT);
    vi.mocked(recordSupplierBankPayment)
      .mockResolvedValueOnce({ paymentId: 'p-frik', appliedLines: [{ invoiceId: 'siv5059', invoiceNumber: 'SIV0005059', amount: 800 }], unappliedRemainder: 0 } as never)
      .mockResolvedValueOnce({ paymentId: 'p-se', appliedLines: [], unappliedRemainder: 1159.48 } as never);

    const result = await split([
      { contactType: 'supplier', contactId: FRIK, amount: 800 },
      { contactType: 'supplier', contactId: SOUTHERN, amount: 1159.48, autoApply: 'none' },
    ]);

    const lines = postedLines();
    expect(lines.filter((l) => l.glAccountId === 'ap-1').map((l) => [l.debit, l.credit, l.vatType, l.cc2Id])).toEqual([
      [800, 0, undefined, undefined], [1159.48, 0, undefined, undefined],
    ]);
    expect(lines.find((l) => l.glAccountId === BANK)).toMatchObject({ debit: 0, credit: 1959.48 });
    expect(lines.some((l) => l.glAccountId === 'vat-in')).toBe(false);
    // A contact-only split is no manual journal: neither journal gate is asked.
    expect(assertBankLineMayPostToAccounts).not.toHaveBeenCalled();
    expect(assertImporterMayAllocate).not.toHaveBeenCalled();
    expect(vi.mocked(recordSupplierBankPayment).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(createJournalEntry).mock.invocationCallOrder[0]!);
    expect(vi.mocked(recordSupplierBankPayment).mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ supplierId: FRIK, amount: 800, journalEntryId: 'je-1', autoApply: 'fifo' }),
      expect.objectContaining({ supplierId: SOUTHERN, amount: 1159.48, journalEntryId: 'je-1', autoApply: 'none' }),
    ]);
    expect(result.contactDocuments).toEqual([
      expect.objectContaining({ index: 0, kind: 'supplier', document: 'payment', paymentId: 'p-frik', onAccount: 0 }),
      expect.objectContaining({ index: 1, kind: 'supplier', document: 'payment', paymentId: 'p-se', onAccount: 1159.48 }),
    ]);
  });
});

describe('a mixed split', () => {
  it('plans dimensions for the GL line only, and judges the journal gates at the WHOLE line', async () => {
    given(OUT);
    vi.mocked(planSplitDimensions).mockResolvedValueOnce({ dims: [{ buId: 'civ' }], warnings: [] } as never);
    vi.mocked(recordSupplierBankPayment).mockResolvedValueOnce({ paymentId: 'p-frik', appliedLines: [], unappliedRemainder: 800 } as never);

    await split([
      { contraAccountId: 'fuel', amount: 1159.48, buId: 'civ' },
      { contactType: 'supplier', contactId: FRIK, amount: 800 },
    ]);

    expect(vi.mocked(planSplitDimensions).mock.calls[0]![2]).toEqual([expect.objectContaining({ contraAccountId: 'fuel' })]);
    expect(vi.mocked(assertBankLineMayPostToAccounts).mock.calls).toEqual([[COMPANY, OUT, 1959.48]]);
    expect(vi.mocked(assertImporterMayAllocate).mock.calls).toEqual([[COMPANY, OUT, USER, 'manual_journal']]);
    expect(vi.mocked(assertBankLineMayPaySupplier).mock.calls).toEqual([[COMPANY, OUT, 800]]);
    const lines = postedLines();
    expect(lines.find((l) => l.glAccountId === 'fuel')).toMatchObject({ debit: 1159.48, buId: 'civ' });
    expect(lines.find((l) => l.glAccountId === 'ap-1')).toMatchObject({ debit: 800 });
  });
});

describe('every refusal lands before the journal', () => {
  it('a journal-gate refusal of the mixed split', async () => {
    given(OUT);
    vi.mocked(assertBankLineMayPostToAccounts).mockRejectedValueOnce(new Error('needs approval'));
    await expect(split([{ contraAccountId: 'fuel', amount: 959.48 }, { contactType: 'supplier', contactId: FRIK, amount: 1000 }]))
      .rejects.toThrow(/needs approval/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('a supplier-payment gate refusal', async () => {
    given(OUT);
    vi.mocked(assertBankLineMayPaySupplier).mockRejectedValueOnce(new Error('needs admin approval'));
    await expect(split([{ contactType: 'supplier', contactId: FRIK, amount: 1959.48 }])).rejects.toThrow(/needs admin approval/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('a line that names neither a GL account nor a contact', async () => {
    given(OUT);
    const err = await split([{ amount: 959.48 }, { contactType: 'supplier', contactId: FRIK, amount: 1000 }]).catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/Split line 1 names neither/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });
});

describe('money in from a customer: a receipt, applied per auto_apply', () => {
  it.each(['fifo', 'none'] as const)('credits AR, inserts the receipt on the journal, applies it %s', async (mode) => {
    given(IN);
    vi.mocked(autoApplyCustomerReceipt).mockResolvedValueOnce({ appliedLines: [], unappliedRemainder: 959.48 } as never);
    const result = await split([
      { contraAccountId: 'sales', amount: 1000 },
      { contactType: 'customer', contactId: CUST, amount: 959.48, ...(mode === 'none' ? { autoApply: 'none' as const } : {}) },
    ]);
    expect(postedLines().find((l) => l.glAccountId === 'ar-1')).toMatchObject({ debit: 0, credit: 959.48 });
    expect(postedLines().find((l) => l.glAccountId === BANK)).toMatchObject({ debit: 1959.48, credit: 0 });
    const insert = vi.mocked(sql).mock.calls.find((c) => (c[0] as unknown as string[]).join('?').includes('INSERT INTO customer_payments'))!;
    expect(insert.slice(1)).toEqual(expect.arrayContaining([COMPANY, CUST, 959.48, 'je-1', USER]));
    expect(vi.mocked(autoApplyCustomerReceipt).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY, customerId: CUST, paymentId: 'rcpt-1', journalEntryId: 'je-1', amount: 959.48, autoApply: mode,
    });
    expect(result.contactDocuments).toEqual([expect.objectContaining({ index: 1, document: 'receipt', paymentId: 'rcpt-1' })]);
  });
});

describe('refunds follow the bank line\'s direction', () => {
  it('money out to a customer: DR AR, a customer refund on the journal', async () => {
    given(OUT);
    vi.mocked(recordCustomerRefund).mockResolvedValueOnce({ paymentId: 'cr-1', amount: -959.48 } as never);
    const result = await split([{ contraAccountId: 'fees', amount: 1000 }, { contactType: 'customer', contactId: CUST, amount: 959.48 }]);
    expect(postedLines().find((l) => l.glAccountId === 'ar-1')).toMatchObject({ debit: 959.48, credit: 0 });
    expect(vi.mocked(recordCustomerRefund).mock.calls[0]![0]).toMatchObject({ customerId: CUST, amount: 959.48, journalEntryId: 'je-1' });
    expect(result.contactDocuments).toEqual([expect.objectContaining({ document: 'refund', paymentId: 'cr-1' })]);
    expect(sqlText().some((q) => q.includes('INSERT INTO customer_payments'))).toBe(false);
  });

  it('money in from a supplier: CR AP, a supplier refund on the journal, no payment', async () => {
    given(IN);
    vi.mocked(recordSupplierRefund).mockResolvedValueOnce({ paymentId: 'sr-1', amount: -1959.48 } as never);
    const result = await split([{ contactType: 'supplier', contactId: FRIK, amount: 1959.48 }]);
    expect(postedLines().find((l) => l.glAccountId === 'ap-1')).toMatchObject({ debit: 0, credit: 1959.48 });
    expect(vi.mocked(recordSupplierRefund).mock.calls[0]![0]).toMatchObject({ supplierId: FRIK, amount: 1959.48, journalEntryId: 'je-1' });
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
    expect(result.contactDocuments).toEqual([expect.objectContaining({ document: 'refund', paymentId: 'sr-1' })]);
  });
});
