/**
 * approveCreditNote, SUPPLIER side (migration 891): the AP debit (total) and the
 * single VAT credit (tax) are as before; the expense credit (subtotal) is
 * whatever ap/supplierCreditNoteExpenseLines decides — the linked bill's own
 * legs — instead of one default_expense line. The allocation rules have their
 * own suite (tests/unit/services/ap/supplierCreditNoteExpenseLines.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockSql, mockCreateJournalEntry, COMPANY_ID, CN_ID, USER_ID, creditNoteRow } from './creditNoteService.harness';

vi.mock('@/modules/accounting/services/ap/supplierCreditNoteExpenseLines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/ap/supplierCreditNoteExpenseLines')>()),
  creditNoteExpenseJournalLines: vi.fn(),
  recordCreditNoteExpenseAllocations: vi.fn(async () => undefined),
}));

// The header CC1 / BU are checked against their masters by dimensionStoredPosting (its own suites);
// this suite is about where the expense credit goes.
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionStoredPosting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/dimensions/dimensionStoredPosting')>()),
  assertPostsStoredDimensions: async () => undefined,
}));

import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import {
  creditNoteExpenseJournalLines, recordCreditNoteExpenseAllocations,
} from '@/modules/accounting/services/ap/supplierCreditNoteExpenseLines';
import { CreditNoteDimensionRefusal } from '@/modules/accounting/services/ar/creditNoteHeaderTags';
import { NO_TAGS } from '@/modules/accounting/services/ar/invoiceRevenueLines';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const BILL = 'cccccccc-0000-4000-8000-cccccccccccc';
const COS = 'cos-account-id';
const OVERHEADS = 'overheads-account-id';
const ALLOCATIONS = [
  { journalLineId: 'jl-1', glAccountId: COS, projectId: null, cc1Id: 'fno', cc2Id: null, buId: null, amount: 700, isExcess: false },
  { journalLineId: 'jl-2', glAccountId: OVERHEADS, projectId: null, cc1Id: null, cc2Id: null, buId: null, amount: 300, isExcess: false },
];

function supplierNote(overrides: Record<string, unknown> = {}) {
  return creditNoteRow({ type: 'supplier', client_id: null, supplier_id: 'supplier-uuid', supplier_invoice_id: BILL, ...overrides });
}

function wire(row: Record<string, unknown>) {
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(row as never);
  mockSql.mockImplementation(((strings: TemplateStringsArray) => {
    const text = (strings as unknown as string[]).join('?');
    if (/SUM\(amount_allocated\)/i.test(text)) return Promise.resolve([{ allocated: 0 }]);
    // The bill is already settled: the FIFO walk applies nothing, which keeps this suite on the journal.
    if (/FOR UPDATE/i.test(text)) return Promise.resolve([{ id: BILL, status: 'approved', outstanding: 0 }]);
    if (/UPDATE credit_notes SET status/i.test(text)) return Promise.resolve([row]);
    return Promise.resolve([]);
  }) as never);
}

const postedLines = (): JournalLineInput[] => (mockCreateJournalEntry.mock.calls[0]![1] as { lines: JournalLineInput[] }).lines;

beforeEach(() => {
  vi.mocked(creditNoteExpenseJournalLines).mockResolvedValue({
    lines: [
      { glAccountId: COS, debit: 0, credit: 700, description: 'Credit note CN-2026-00001', cc1Id: 'fno' },
      { glAccountId: OVERHEADS, debit: 0, credit: 300, description: 'Credit note CN-2026-00001' },
    ],
    allocations: ALLOCATIONS,
  });
});

describe('approveCreditNote — supplier note linked to a bill', () => {
  it('posts AP = total and VAT = tax as before, and the bill\'s own legs for the subtotal — nothing on default_expense', async () => {
    wire(supplierNote());
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    const lines = postedLines();
    expect(lines[0]).toMatchObject({ glAccountId: 'payable-account-id', debit: 1150, credit: 0 });
    expect(lines[1]).toMatchObject({ glAccountId: 'vat_input-account-id', debit: 0, credit: 150, vatType: 'standard' });
    expect(lines.slice(2).map((l) => [l.glAccountId, l.credit])).toEqual([[COS, 700], [OVERHEADS, 300]]);
    expect(lines.some((l) => l.glAccountId === 'default_expense-account-id')).toBe(false);
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    expect(debit).toBe(credit);
  });

  it('asks for the bill\'s legs with the note\'s own account and no header tags, and records what it took', async () => {
    wire(supplierNote({ gl_account_id: 'note-account-id' }));
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(creditNoteExpenseJournalLines).toHaveBeenCalledWith(COMPANY_ID, {
      id: CN_ID, number: 'CN-2026-00001', amount: 1000, supplierInvoiceId: BILL, glAccountId: 'note-account-id', tags: NO_TAGS,
    }, { defaultExpenseAccountId: 'default_expense-account-id', payableAccountId: 'payable-account-id',
      vatInputAccountId: 'vat_input-account-id' });
    expect(recordCreditNoteExpenseAllocations).toHaveBeenCalledWith(COMPANY_ID, CN_ID, BILL, ALLOCATIONS);
  });

  it('refuses header CC1 / CC2 / BU on a linked note before anything is written', async () => {
    wire(supplierNote({ cc1_id: 'fno-uuid' }));
    await expect(approveCreditNote(COMPANY_ID, CN_ID, USER_ID)).rejects.toBeInstanceOf(CreditNoteDimensionRefusal);
    expect(mockCreateJournalEntry).not.toHaveBeenCalled();
    expect(recordCreditNoteExpenseAllocations).not.toHaveBeenCalled();
  });
});

describe('approveCreditNote — unlinked supplier note', () => {
  it('passes its header CC1 / CC2 / BU to the expense credit and records no allocation', async () => {
    const row = supplierNote({ supplier_invoice_id: null, cc1_id: 'fno-uuid', bu_id: 'bu-uuid' });
    wire(row);
    vi.mocked(creditNoteExpenseJournalLines).mockResolvedValue({
      lines: [{ glAccountId: 'default_expense-account-id', debit: 0, credit: 1000, description: 'x', cc1Id: 'fno-uuid', buId: 'bu-uuid' }],
      allocations: [],
    });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(vi.mocked(creditNoteExpenseJournalLines).mock.calls[0]![1]).toMatchObject({
      supplierInvoiceId: null, glAccountId: null, tags: { projectId: null, cc1Id: 'fno-uuid', cc2Id: null, buId: 'bu-uuid' },
    });
    expect(postedLines().map((l) => [l.glAccountId, l.debit, l.credit])).toEqual([
      ['payable-account-id', 1150, 0], ['vat_input-account-id', 0, 150], ['default_expense-account-id', 0, 1000],
    ]);
    expect(recordCreditNoteExpenseAllocations).not.toHaveBeenCalled();
  });
});
