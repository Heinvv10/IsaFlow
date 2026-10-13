/**
 * A supplier credit note's expense credit (migration 891): the linked bill's
 * own expense / COS / asset legs pro rata, capped at what each still carries,
 * then the note's own account, then default_expense. The reads are answered by
 * query SHAPE, so the allocation rules are pinned here and proven to balance
 * against the real journal validator; the real-PG proof is
 * tests/integration/supplier-credit-note-bill-accounts.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { ...actual, sql: vi.fn() };
});
vi.mock('@/modules/accounting/services/ap/billLineAccountGuard', () => ({
  assertBillLineAccounts: vi.fn(async () => undefined),
}));

import { sql } from '@/lib/neon';
import { assertBillLineAccounts } from '@/modules/accounting/services/ap/billLineAccountGuard';
import {
  assertSupplierNoteHeaderTags, billExpenseLegs, creditNoteExpenseJournalLines, isBillExpenseLeg,
  type BillJournalLegRow,
} from '@/modules/accounting/services/ap/supplierCreditNoteExpenseLines';
import { CreditNoteDimensionRefusal } from '@/modules/accounting/services/ar/creditNoteHeaderTags';
import { NO_TAGS } from '@/modules/accounting/services/ar/invoiceRevenueLines';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const AP = 'acct-ap';
const VAT = 'acct-vat-input';
const DEFAULT = 'acct-5100';
const COS = 'acct-cos-subcontractors';
const OVERHEADS = 'acct-cos-overheads';
const ASSET = 'acct-fixed-assets';
const NOTE_ACCOUNT = 'acct-note-own';
const BILL = 'bill-1';
const ACCOUNTS = { defaultExpenseAccountId: DEFAULT, payableAccountId: AP, vatInputAccountId: VAT };

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
let legs: BillJournalLegRow[] = [];
let taken: { journal_line_id: string; amount: number }[] = [];
let legacy: { subtotal: number }[] = [];

function leg(id: string, account: string, net: number, extra: Partial<BillJournalLegRow> = {}): BillJournalLegRow {
  return { journal_line_id: id, gl_account_id: account, is_active: true, account_subtype: 'cost_of_sales',
    project_id: null, cc1_id: null, cc2_id: null, bu_id: null, net, ...extra };
}
/** A posted bill: its expense legs, plus the VAT debit and the AP credit the workflow adds. */
function bill(expense: BillJournalLegRow[], vat: number): BillJournalLegRow[] {
  const total = expense.reduce((s, l) => s + Number(l.net), 0) + vat;
  return [...expense,
    leg('jl-vat', VAT, vat, { account_subtype: 'vat_input' }),
    leg('jl-ap', AP, -total, { account_subtype: 'payable' })];
}

beforeEach(() => {
  vi.clearAllMocks();
  legs = []; taken = []; legacy = [];
  mockSql.mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/FROM supplier_invoices si/.test(text)) return Promise.resolve(legs);
    if (/SUM\(a\.amount\)/.test(text)) return Promise.resolve(taken);
    if (/SELECT cn\.subtotal/.test(text)) return Promise.resolve(legacy);
    return Promise.resolve([]);
  }) as never);
});

const note = (amount: number, over: Partial<Parameters<typeof creditNoteExpenseJournalLines>[1]> = {}) => ({
  id: 'cn-1', number: 'CN-1', amount, supplierInvoiceId: BILL, glAccountId: null, tags: NO_TAGS, ...over,
});
const run = (amount: number, over: Partial<Parameters<typeof creditNoteExpenseJournalLines>[1]> = {}) =>
  creditNoteExpenseJournalLines('co-1', note(amount, over), ACCOUNTS);
const credits = (lines: JournalLineInput[]) => Object.fromEntries(lines.map((l) => [
  [l.glAccountId, l.cc1Id ?? '', l.cc2Id ?? '', l.buId ?? '', l.projectId ?? ''].filter(Boolean).join('/'),
  Math.round((l.credit - l.debit) * 100) / 100,
]));
/** The note's whole journal: AP debit = total, VAT credit = tax, expense = subtotal. */
const balances = (expense: JournalLineInput[], subtotal: number, tax: number) => validateJournalEntry([
  { glAccountId: AP, debit: subtotal + tax, credit: 0 },
  ...(tax > 0 ? [{ glAccountId: VAT, debit: 0, credit: tax }] : []),
  ...expense,
]).valid;

describe('linked to a bill with a journal', () => {
  it('credits the bill\'s own legs 70/30, carrying account, CC1, CC2, BU and job — never AP or VAT', async () => {
    legs = bill([
      leg('jl-1', COS, 7000, { cc1_id: 'fno-ft', cc2_id: 'law', bu_id: 'act', project_id: 'job-1' }),
      leg('jl-2', OVERHEADS, 3000, { cc1_id: 'fno-ht' }),
    ], 1500);
    const { lines, allocations } = await run(1000);
    expect(credits(lines)).toEqual({ [`${COS}/fno-ft/law/act/job-1`]: 700, [`${OVERHEADS}/fno-ht`]: 300 });
    expect(lines.every((l) => l.debit === 0 && l.description === 'Credit note CN-1')).toBe(true);
    expect(allocations.map((a) => [a.journalLineId, a.amount, a.isExcess])).toEqual([['jl-1', 700, false], ['jl-2', 300, false]]);
    expect(balances(lines, 1000, 150)).toBe(true);
    expect(lines.some((l) => l.glAccountId === AP || l.glAccountId === VAT || l.glAccountId === DEFAULT)).toBe(false);
  });

  it('is exact to the cent: the rounding residual lands on one leg and the legs sum to the net', async () => {
    legs = bill([leg('jl-1', COS, 100), leg('jl-2', OVERHEADS, 100), leg('jl-3', ASSET, 100)], 0);
    const { lines } = await run(100);
    const sum = lines.reduce((s, l) => s + Math.round(l.credit * 100), 0);
    expect(sum).toBe(10000);
    expect(lines.map((l) => l.credit).sort()).toEqual([33.33, 33.33, 33.34]);
  });

  it('a partial note takes each leg pro rata', async () => {
    legs = bill([leg('jl-1', COS, 600), leg('jl-2', ASSET, 400, { account_subtype: 'fixed_asset' })], 150);
    expect(credits((await run(250)).lines)).toEqual({ [COS]: 150, [ASSET]: 100 });
  });

  it('a second note takes only what the first left; the rest goes to default_expense, untagged', async () => {
    legs = bill([leg('jl-1', COS, 600, { cc1_id: 'fno-ft' }), leg('jl-2', OVERHEADS, 400)], 0);
    taken = [{ journal_line_id: 'jl-1', amount: 600 }, { journal_line_id: 'jl-2', amount: 300 }];
    const { lines, allocations } = await run(300);
    expect(credits(lines)).toEqual({ [OVERHEADS]: 100, [DEFAULT]: 200 });
    expect(allocations.find((a) => a.isExcess)).toMatchObject({ glAccountId: DEFAULT, amount: 200, journalLineId: null, cc1Id: null });
  });

  it('the excess goes to the note\'s own account when it names one', async () => {
    legs = bill([leg('jl-1', COS, 100)], 0);
    expect(credits((await run(150, { glAccountId: NOTE_ACCOUNT })).lines)).toEqual({ [COS]: 100, [NOTE_ACCOUNT]: 50 });
    expect(assertBillLineAccounts).toHaveBeenCalledWith('co-1', [NOTE_ACCOUNT]);
  });

  it('notes approved before 891 (no rows) are replayed against the legs', async () => {
    legs = bill([leg('jl-1', COS, 500), leg('jl-2', OVERHEADS, 500)], 0);
    legacy = [{ subtotal: 800 }];
    expect(credits((await run(300)).lines)).toEqual({ [COS]: 100, [OVERHEADS]: 100, [DEFAULT]: 100 });
  });

  it('a leg whose account was deactivated is credited on the fallback, keeping its tags', async () => {
    legs = bill([leg('jl-1', COS, 100, { is_active: false, cc1_id: 'fno-ft' })], 0);
    expect(credits((await run(100)).lines)).toEqual({ [`${DEFAULT}/fno-ft`]: 100 });
  });

  it('a discount leg on the bill is reversed as a debit on its own account', async () => {
    legs = bill([leg('jl-1', COS, 1200), leg('jl-2', OVERHEADS, -200)], 0);
    const { lines } = await run(500);
    expect(credits(lines)).toEqual({ [COS]: 600, [OVERHEADS]: -100 });
    expect(balances(lines, 500, 0)).toBe(true);
  });

  it('the VAT, AP and VAT-class legs are left out by role', async () => {
    legs = [leg('jl-1', COS, 1000), leg('jl-v', VAT, 150), leg('jl-o', 'acct-vat-control', 5, { account_subtype: 'vat_output' }),
      leg('jl-p', 'acct-other-ap', -5, { account_subtype: 'trade_payables' }), leg('jl-ap', AP, -1150, { account_subtype: null })];
    expect(credits((await run(100)).lines)).toEqual({ [COS]: 100 });
  });
});

describe('no usable bill', () => {
  it('a bill with no journal: the whole net goes to the note\'s account, else default_expense', async () => {
    legs = [];
    expect(credits((await run(100, { glAccountId: NOTE_ACCOUNT })).lines)).toEqual({ [NOTE_ACCOUNT]: 100 });
    expect(credits((await run(100)).lines)).toEqual({ [DEFAULT]: 100 });
  });

  it('unlinked, naming an account: one credit there carrying the header CC1 / CC2 / BU, no reads', async () => {
    const tags = { projectId: null, cc1Id: 'fno-ft', cc2Id: 'law', buId: 'act' };
    const out = await run(250, { supplierInvoiceId: null, glAccountId: NOTE_ACCOUNT, tags });
    expect(credits(out.lines)).toEqual({ [`${NOTE_ACCOUNT}/fno-ft/law/act`]: 250 });
    expect(out.allocations).toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('unlinked, no account: default_expense, as every supplier note posted before 891', async () => {
    const out = await run(250, { supplierInvoiceId: null });
    expect(out.lines).toEqual([{ glAccountId: DEFAULT, debit: 0, credit: 250, description: 'Credit note CN-1' }]);
  });
});

describe('pure helpers', () => {
  it('isBillExpenseLeg keeps expense, COS and asset legs and drops AP / VAT by role', () => {
    const roles = new Set([AP, VAT]);
    expect(isBillExpenseLeg({ gl_account_id: ASSET, account_subtype: 'fixed_asset' }, roles)).toBe(true);
    expect(isBillExpenseLeg({ gl_account_id: COS, account_subtype: null }, roles)).toBe(true);
    expect(isBillExpenseLeg({ gl_account_id: AP, account_subtype: null }, roles)).toBe(false);
    expect(isBillExpenseLeg({ gl_account_id: 'x', account_subtype: 'payable' }, roles)).toBe(false);
    expect(isBillExpenseLeg({ gl_account_id: 'x', account_subtype: 'vat_input' }, roles)).toBe(false);
  });

  it('billExpenseLegs reads what earlier notes took per journal line', () => {
    const out = billExpenseLegs([leg('jl-1', COS, 100)], new Set([AP]), new Map([['jl-1', 40]]), DEFAULT);
    expect(out[0]).toMatchObject({ glAccountId: COS, postAccountId: COS, net: 100, taken: 40, journalLineId: 'jl-1' });
  });

  it('header CC1 / CC2 / BU are refused on a linked note and posted on an unlinked one', () => {
    expect(() => assertSupplierNoteHeaderTags({ supplierInvoiceId: BILL, cc1Id: 'fno', cc2Id: null, buId: null }))
      .toThrow(CreditNoteDimensionRefusal);
    expect(assertSupplierNoteHeaderTags({ supplierInvoiceId: BILL, cc1Id: null, cc2Id: null, buId: null })).toEqual(NO_TAGS);
    expect(assertSupplierNoteHeaderTags({ supplierInvoiceId: null, cc1Id: 'fno', cc2Id: 'law', buId: null }))
      .toEqual({ projectId: null, cc1Id: 'fno', cc2Id: 'law', buId: null });
  });
});
