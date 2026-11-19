/**
 * approveCreditNote with auto_apply 'none' / 'linked' (Hein, 2026-11-13).
 *
 * CN-2026-00563 (Velocity, 12 Nov) was approved with auto_apply 'none' and was
 * still applied to its linked bill: 'none' then meant "skip only the FIFO walk".
 * The contract is now three-way:
 *   fifo   — linked document first, remainder oldest first (default, unchanged)
 *   linked — the linked document only (what 'none' used to do)
 *   none   — post the journal, apply NOTHING; the credit stays on account
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockSql, mockCreateJournalEntry, COMPANY_ID, CN_ID, USER_ID, creditNoteRow } from './creditNoteService.harness';

vi.mock('@/modules/accounting/services/ap/supplierCreditNoteExpenseLines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/ap/supplierCreditNoteExpenseLines')>()),
  creditNoteExpenseJournalLines: vi.fn(),
  recordCreditNoteExpenseAllocations: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionStoredPosting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/dimensions/dimensionStoredPosting')>()),
  assertPostsStoredDimensions: async () => undefined,
}));

import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { creditNoteExpenseJournalLines } from '@/modules/accounting/services/ap/supplierCreditNoteExpenseLines';

const BILL = 'cccccccc-0000-4000-8000-cccccccccccc';
const OTHER_BILL = 'dddddddd-0000-4000-8000-dddddddddddd';

/** A supplier note linked to BILL, which still has the note's full value open; OTHER_BILL is open too. */
function wire() {
  const row = creditNoteRow({ type: 'supplier', client_id: null, supplier_id: 'supplier-uuid', supplier_invoice_id: BILL });
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(row as never);
  mockSql.mockImplementation(((strings: TemplateStringsArray) => {
    const text = (strings as unknown as string[]).join('?');
    if (/SUM\(amount_allocated\)/i.test(text)) return Promise.resolve([{ allocated: 0 }]);
    if (/FOR UPDATE/i.test(text)) {
      return Promise.resolve([
        { id: BILL, status: 'approved', outstanding: 1150 },
        { id: OTHER_BILL, status: 'approved', outstanding: 5000 },
      ]);
    }
    if (/UPDATE supplier_invoices d SET amount_paid/i.test(text)) return Promise.resolve([{ moved: 1150 }]);
    if (/UPDATE credit_notes SET status/i.test(text)) return Promise.resolve([row]);
    return Promise.resolve([]);
  }) as never);
}

/** The invoice ids each credit_note_allocations INSERT named. */
function allocatedInvoices(): unknown[] {
  return mockSql.mock.calls
    .filter((c) => ((c[0] as unknown as string[]).join('?')).includes('INSERT INTO credit_note_allocations'))
    .map((c) => (c as unknown[]).find((v) => v === BILL || v === OTHER_BILL));
}

beforeEach(() => {
  vi.mocked(creditNoteExpenseJournalLines).mockResolvedValue({
    lines: [{ glAccountId: 'cos', debit: 0, credit: 1000, description: 'x' }],
    allocations: [],
  });
});

describe('approveCreditNote — auto_apply on a LINKED supplier note', () => {
  it('"none" posts the journal and applies nothing, not even to the linked bill', async () => {
    wire();
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { autoApply: 'none' });
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1);
    expect(allocatedInvoices()).toEqual([]);
  });

  it('"linked" applies to the linked bill only', async () => {
    wire();
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { autoApply: 'linked' });
    expect(allocatedInvoices()).toEqual([BILL]);
  });
});
