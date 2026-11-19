/**
 * approveCreditNote and a note its typed invoice cannot carry (creditNoteTypedSplit): the refusal is raised while the
 * note's revenue debits are worked out, BEFORE any write, so the route's 400 (credit-notes-action, answered with
 * CREDIT_NOTE_VAT_SPLIT_REFUSED) commits nothing: no journal is created and no statement writes. The reader, the split
 * and the approval run for real; `sql` answers the invoice journal's typed legs by statement.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockSql, mockCreateJournalEntry, COMPANY_ID, CN_ID, USER_ID, creditNoteRow } from './creditNoteService.harness';

vi.mock('@/modules/accounting/services/gl/dimensions/dimensionStoredPosting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/dimensions/dimensionStoredPosting')>()),
  assertPostsStoredDimensions: async () => undefined,
}));

import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';

const INVOICE = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const leg = (id: string, net: string, vatType: string) => ({ journal_line_id: id, gl_account_id: 'acct-sales', is_active: true,
  project_id: null, cc1_id: null, cc2_id: null, bu_id: null, vat_type: vatType, net });

function wire(subtotal: number, taxAmount: number) {
  const row = creditNoteRow({ customer_invoice_id: INVOICE, subtotal, tax_amount: taxAmount, total_amount: subtotal + taxAmount });
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(row as never);
  mockSql.mockImplementation(((strings: TemplateStringsArray) => {
    const text = (strings as unknown as string[]).join('?');
    if (/AS journal_line_id, jl\.gl_account_id/.test(text)) {
      return Promise.resolve([leg('s', '1000.00', 'standard'), leg('z', '300.00', 'zero_rated'), leg('e', '200.00', 'exempt')]);
    }
    return Promise.resolve([]);
  }) as never);
}

const writes = () => mockSql.mock.calls
  .map((c) => (c[0] as unknown as string[]).join('?'))
  .filter((t) => /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(t));

describe('approveCreditNote, a note its typed invoice cannot carry', () => {
  it('refuses before any write: no journal, no INSERT, UPDATE or DELETE', async () => {
    wire(1100, 165);
    const err = await approveCreditNote(COMPANY_ID, CN_ID, USER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditNoteVatSplitRefusal);
    expect((err as CreditNoteVatSplitRefusal).code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
    expect(mockCreateJournalEntry).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('a note it can carry gets as far as its journal, on the split legs', async () => {
    wire(200, 30);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID).catch(() => undefined); // what follows the journal is not this test's
    const lines = (mockCreateJournalEntry.mock.calls[0]![1] as { lines: { debit: number; vatType?: string }[] }).lines;
    expect(lines.filter((l) => l.debit > 0).map((l) => [l.debit, l.vatType])).toEqual([[200, 'standard'], [30, 'standard']]);
  });
});
