/**
 * Dimensions Phase 1 — bank allocation POSTING carries CC1/CC2/BU onto the cost
 * line only: single allocation (with card defaults), split allocation (per
 * line), and a settlement that names dimensions is refused before any write.
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

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { planSplitDimensions } from '@/modules/accounting/services/bank/bankSplitDimensions';
import { allocateTransaction, splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { enterFakeRequestCtx } from '../../helpers/requestCtx';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJE = createJournalEntry as unknown as MockedFunction<(...args: unknown[]) => Promise<{ id: string }>>;
const mockPlanSplit = planSplitDimensions as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown>>;

const COMPANY = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const USER = '00000000-0000-0000-0000-000000000001';
const BANK = 'bank-acct';
const TX = { id: 'tx-1', bank_account_id: BANK, amount: -115, transaction_date: '2026-09-10', status: 'imported', feed_state: 'posted', description: 'Card' };

type Line = { glAccountId: string; cc1Id?: string; cc2Id?: string; buId?: string; vatType?: string };
const postedLines = (): Line[] => (mockCreateJE.mock.calls[0]![1] as { lines: Line[] }).lines;

beforeEach(() => {
  vi.clearAllMocks();
  enterFakeRequestCtx();
});

describe('single allocation', () => {
  it('a paycard cost line with no dimensions takes the card defaults; the bank and VAT lines carry none', async () => {
    mockSql
      .mockResolvedValueOnce([TX])
      .mockResolvedValueOnce([{
        account_code: '5100', account_name: 'Fuel', account_subtype: 'cost_of_sales',
        bank_cc1_id: 'fno-ft', bank_cc2_id: null, bank_bu_id: 'bu-build',
      }])
      .mockResolvedValueOnce([{ id: 'jl-1' }])
      .mockResolvedValueOnce([TX]);
    await allocateTransaction(COMPANY, 'tx-1', 'fuel', USER, 'Fuel', 'account', undefined, 'standard');
    const lines = postedLines();
    expect(lines.find((l) => l.glAccountId === 'fuel')).toMatchObject({ cc1Id: 'fno-ft', buId: 'bu-build' });
    for (const l of lines.filter((x) => x.glAccountId !== 'fuel')) {
      expect(l.cc1Id ?? l.cc2Id ?? l.buId).toBeUndefined();
    }
  });

  it('REFUSES dimensions on a supplier payment before writing anything', async () => {
    mockSql.mockResolvedValueOnce([TX]);
    const err = await allocateTransaction(COMPANY, 'tx-1', null, USER, 'Pay', 'supplier', 'sup-1', 'none', undefined, 'proj-1')
      .catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err)).toBe(true);
    expect(mockCreateJE).not.toHaveBeenCalled();
  });
});

describe('split allocation', () => {
  it('carries each split line\'s dimensions onto its own cost line, never the VAT or bank line', async () => {
    mockPlanSplit.mockResolvedValueOnce({
      dims: [{ cc1Id: 'fno', cc2Id: 'lawley', buId: 'build' }, { buId: 'maint' }],
      warnings: ['split line 2: cost-of-sales line with no project (CC2)'],
    });
    mockSql
      .mockResolvedValueOnce([TX])
      .mockResolvedValueOnce([{ id: 'jl-1' }])
      .mockResolvedValueOnce([TX]);
    const result = await splitAllocateTransaction(COMPANY, 'tx-1', [
      { contraAccountId: 'fuel', amount: 69, vatCode: 'standard', cc2Id: 'lawley' },
      { contraAccountId: 'tolls', amount: 46, buId: 'maint' },
    ], USER);
    const lines = postedLines();
    expect(lines.find((l) => l.glAccountId === 'fuel')).toMatchObject({ cc1Id: 'fno', cc2Id: 'lawley', buId: 'build' });
    expect(lines.find((l) => l.glAccountId === 'tolls')).toMatchObject({ buId: 'maint' });
    const vat = lines.find((l) => l.vatType === 'standard' && l.glAccountId === 'vat-in')!;
    expect(vat.cc1Id ?? vat.cc2Id ?? vat.buId).toBeUndefined();
    const bank = lines.find((l) => l.glAccountId === BANK)!;
    expect(bank.cc1Id ?? bank.cc2Id ?? bank.buId).toBeUndefined();
    expect(result.dimensionWarnings).toEqual(['split line 2: cost-of-sales line with no project (CC2)']);
    // The plan saw the caller's dimensions and the bank account, before the journal.
    expect(mockPlanSplit.mock.calls[0]![1]).toBe(BANK);
    expect(mockPlanSplit.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJE.mock.invocationCallOrder[0]!);
  });
});

// The REST split route forwards each line's vatCode (tests/unit/api/bankSplitVatCode.test.ts); this is
// what the service then posts for each code the split modal offers.
describe('split allocation — each VAT code posts as the user chose', () => {
  it('standard: net + a VAT leg; none / zero_rated / exempt: gross, no VAT leg, the code stamped', async () => {
    mockPlanSplit.mockResolvedValueOnce({ dims: [{}, {}, {}, {}], warnings: [] });
    mockSql.mockResolvedValueOnce([{ ...TX, amount: -230 }]).mockResolvedValueOnce([{ id: 'jl-1' }]).mockResolvedValueOnce([TX]);
    await splitAllocateTransaction(COMPANY, 'tx-1', [
      { contraAccountId: 'fuel', amount: 115, vatCode: 'standard' },
      { contraAccountId: 'tolls', amount: 50, vatCode: 'none' },
      { contraAccountId: 'export', amount: 40, vatCode: 'zero_rated' },
      { contraAccountId: 'fees', amount: 25, vatCode: 'exempt' },
    ], USER);
    const lines = postedLines();
    const on = (id: string) => lines.filter((l) => l.glAccountId === id);
    expect(on('fuel')).toEqual([expect.objectContaining({ debit: 100, credit: 0, vatType: 'standard' })]);
    expect(on('vat-in')).toEqual([expect.objectContaining({ debit: 15, credit: 0, vatType: 'standard' })]);
    expect(on('tolls')).toEqual([expect.objectContaining({ debit: 50, vatType: undefined })]);
    expect(on('export')).toEqual([expect.objectContaining({ debit: 40, vatType: 'zero_rated' })]);
    expect(on('fees')).toEqual([expect.objectContaining({ debit: 25, vatType: 'exempt' })]);
    expect(on(BANK)).toEqual([expect.objectContaining({ debit: 0, credit: 230 })]);
  });
});
