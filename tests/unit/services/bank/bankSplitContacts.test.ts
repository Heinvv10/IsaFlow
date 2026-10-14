/**
 * Split allocation with SUPPLIER / CUSTOMER lines (bankSplitContacts.ts):
 * one bank line that settles two contacts, or a contact and a GL account.
 *
 *   · a contact line posts to the AP/AR control account — no VAT, no dimensions —
 *     and its document is recorded AFTER the journal, on that journal
 *   · only the GL-account lines go through the dimension plan
 *   · VAT or dimensions on a contact line are refused before anything is written
 *   · two refund lines to one contact are checked against the refund ceiling as their sum
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankLineJournalGate', () => ({
  handKeyedAccountLineSkips: vi.fn(async () => new Map()), assertBankLineMayPostToAccounts: vi.fn(),
  handKeyedLineJournalRefusal: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/ap/bankLinePaymentGate', () => ({ assertBankLineMayPaySupplier: vi.fn() }));
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
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
  postJournalEntry: vi.fn(async () => ({})),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccountId: vi.fn(async () => 'ap-1') }));
vi.mock('@/modules/accounting/services/bank/bankVatAccountResolver', () => ({ resolveVatAccountId: vi.fn(async () => 'vat-in') }));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({ mapTxRow: vi.fn((row: unknown) => row) }));
vi.mock('@/modules/accounting/services/bank/bankSplitDimensions', () => ({ planSplitDimensions: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', () => ({
  assertImporterMayAllocate: vi.fn(), assertImporterMayAllocateAs: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierRefundDocument', () => ({
  planSupplierRefund: vi.fn(), recordSupplierRefund: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierAutoAllocate', () => ({ recordSupplierBankPayment: vi.fn() }));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { planSplitDimensions } from '@/modules/accounting/services/bank/bankSplitDimensions';
import { planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { planSplitContacts } from '@/modules/accounting/services/bank/bankSplitContacts';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { enterFakeRequestCtx } from '../../helpers/requestCtx';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJE = createJournalEntry as unknown as MockedFunction<(...args: unknown[]) => Promise<{ id: string }>>;
const mockPlanSplit = planSplitDimensions as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown>>;
const mockRecordPayment = recordSupplierBankPayment as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown>>;

const COMPANY = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const USER = '00000000-0000-0000-0000-000000000001';
const BANK = 'bank-acct';
const FRIK = 'sup-frik';
const SOUTHERN = 'sup-southern';
const TX = { id: 'tx-1', bank_account_id: BANK, amount: -1959.48, transaction_date: '2026-10-07', status: 'imported', feed_state: 'posted', description: 'Frik Basson', reference: 'SAGE1' };

type Line = { glAccountId: string; debit: number; credit: number; vatType?: string; cc1Id?: string; cc2Id?: string; buId?: string };
const postedLines = (): Line[] => (mockCreateJE.mock.calls[0]![1] as { lines: Line[] }).lines;

beforeEach(() => {
  vi.clearAllMocks();
  enterFakeRequestCtx();
});

describe('split onto two suppliers', () => {
  it('posts one AP line per supplier with no VAT or dimensions, then records each payment on the journal', async () => {
    mockPlanSplit.mockResolvedValueOnce({ dims: [], warnings: [] });
    mockSql
      .mockResolvedValueOnce([TX])                       // lock
      .mockResolvedValueOnce([{ name: 'Tech - Frik Basson' }])
      .mockResolvedValueOnce([{ name: 'Southern Elements' }])
      .mockResolvedValueOnce([{ id: 'jl-bank' }])        // bank journal line
      .mockResolvedValueOnce([TX]);                      // re-read
    mockRecordPayment
      .mockResolvedValueOnce({ paymentId: 'p-frik', appliedLines: [{ invoiceId: 'siv5059', invoiceNumber: 'SIV0005059', amount: 800 }], unappliedRemainder: 0 })
      .mockResolvedValueOnce({ paymentId: 'p-se', appliedLines: [], unappliedRemainder: 1159.48 });

    const result = await splitAllocateTransaction(COMPANY, 'tx-1', [
      { contactType: 'supplier', contactId: FRIK, amount: 800 },
      { contactType: 'supplier', contactId: SOUTHERN, amount: 1159.48, autoApply: 'none' },
    ], USER);

    const lines = postedLines();
    const ap = lines.filter((l) => l.glAccountId === 'ap-1');
    expect(ap.map((l) => l.debit)).toEqual([800, 1159.48]);
    for (const l of ap) {
      expect(l.vatType).toBeUndefined();
      expect(l.cc1Id ?? l.cc2Id ?? l.buId).toBeUndefined();
    }
    expect(lines.find((l) => l.glAccountId === BANK)).toMatchObject({ credit: 1959.48 });
    expect(lines.some((l) => l.glAccountId === 'vat-in')).toBe(false);
    // No GL-account line → nothing to plan dimensions for.
    expect(mockPlanSplit.mock.calls[0]![2]).toEqual([]);
    // Documents after the journal, on it, with each line's own amount and mode.
    expect(mockRecordPayment.mock.invocationCallOrder[0]).toBeGreaterThan(mockCreateJE.mock.invocationCallOrder[0]!);
    expect(mockRecordPayment.mock.calls[0]![0]).toMatchObject({ supplierId: FRIK, amount: 800, journalEntryId: 'je-1', autoApply: 'fifo' });
    expect(mockRecordPayment.mock.calls[1]![0]).toMatchObject({ supplierId: SOUTHERN, amount: 1159.48, journalEntryId: 'je-1', autoApply: 'none' });
    expect(result.contactDocuments).toEqual([
      expect.objectContaining({ index: 0, kind: 'supplier', document: 'payment', paymentId: 'p-frik', onAccount: 0 }),
      expect.objectContaining({ index: 1, kind: 'supplier', document: 'payment', paymentId: 'p-se', onAccount: 1159.48 }),
    ]);
  });

  it('a mixed split sends only the GL-account line through the dimension plan', async () => {
    mockPlanSplit.mockResolvedValueOnce({ dims: [{ buId: 'civ' }], warnings: [] });
    mockSql
      .mockResolvedValueOnce([TX])
      .mockResolvedValueOnce([{ name: 'Tech - Frik Basson' }])
      .mockResolvedValueOnce([{ id: 'jl-bank' }])
      .mockResolvedValueOnce([TX]);
    mockRecordPayment.mockResolvedValueOnce({ paymentId: 'p-frik', appliedLines: [], unappliedRemainder: 800 });

    await splitAllocateTransaction(COMPANY, 'tx-1', [
      { contraAccountId: 'fuel', amount: 1159.48, buId: 'civ' },
      { contactType: 'supplier', contactId: FRIK, amount: 800 },
    ], USER);

    expect(mockPlanSplit.mock.calls[0]![2]).toEqual([expect.objectContaining({ contraAccountId: 'fuel' })]);
    const lines = postedLines();
    expect(lines.find((l) => l.glAccountId === 'fuel')).toMatchObject({ debit: 1159.48, buId: 'civ' });
    expect(lines.find((l) => l.glAccountId === 'ap-1')).toMatchObject({ debit: 800 });
  });
});

describe('planSplitContacts — refusals before any write', () => {
  it('refuses VAT on a supplier line', async () => {
    const err = await planSplitContacts(COMPANY, TX, [
      { contactType: 'supplier', contactId: FRIK, amount: 800, vatCode: 'standard' },
    ], USER).catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/carries no VAT/);
  });

  it('refuses dimensions on a supplier line', async () => {
    const err = await planSplitContacts(COMPANY, TX, [
      { contactType: 'supplier', contactId: FRIK, amount: 800, cc2Id: 'lawley' },
    ], USER).catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/carries no CC1\/CC2\/BU/);
  });

  it('checks two refund lines to one supplier against the ceiling as their sum', async () => {
    const refundTx = { ...TX, amount: 300 };
    mockSql.mockResolvedValue([{ name: 'Southern Elements' }]);
    await planSplitContacts(COMPANY, refundTx, [
      { contactType: 'supplier', contactId: SOUTHERN, amount: 100 },
      { contactType: 'supplier', contactId: SOUTHERN, amount: 200 },
    ], USER);
    expect(planSupplierRefund).toHaveBeenCalledTimes(1);
    expect(vi.mocked(planSupplierRefund).mock.calls[0]).toEqual([COMPANY, SOUTHERN, 300, '2026-10-07']);
  });

  it('ignores GL-account lines', async () => {
    const planned = await planSplitContacts(COMPANY, TX, [{ contraAccountId: 'fuel', amount: 1959.48, vatCode: 'standard' }], USER);
    expect(planned).toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
