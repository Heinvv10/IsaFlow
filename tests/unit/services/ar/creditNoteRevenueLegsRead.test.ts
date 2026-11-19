/**
 * creditNoteRevenueJournalLines reads the invoice journal's revenue legs WITH their vat_type (PR #1648 review T4):
 * coded legs give the note's debits their type and route a typed invoice through the VAT split
 * (creditNoteTypedSplit); uncoded legs, or a spelling the ledger does not store ('zero'), stay uncoded and the note
 * splits pro rata over every leg exactly as before. `sql` is answered by statement, not call order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ legs: [] as Record<string, unknown>[], texts: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[]) => {
    const text = strings.join('?');
    db.texts.push(text);
    if (/AS journal_line_id, jl\.gl_account_id/.test(text)) return db.legs;
    return []; // nothing taken by earlier notes; no pre-874 notes
  }),
}));

import { creditNoteRevenueJournalLines } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';

const DEFAULT = 'acct-default';
const row = (id: string, net: string, vatType: string | null) => ({
  journal_line_id: id, gl_account_id: 'acct-sales', is_active: true, project_id: null, cc1_id: null, cc2_id: null, bu_id: null,
  vat_type: vatType, net,
});
const NO_TAGS = { projectId: null, cc1Id: null, cc2Id: null, buId: null };
const read = (amount: number, taxAmount: number) => creditNoteRevenueJournalLines('co', {
  id: 'cn', number: 'CN-1', amount, taxAmount, date: '2026-07-20', customerInvoiceId: 'inv', tags: NO_TAGS,
}, DEFAULT);
const debits = async (amount: number, taxAmount: number) => (await read(amount, taxAmount)).lines.map((l) => [l.debit, l.vatType ?? null]);

describe('creditNoteRevenueJournalLines and the invoice legs\' vat_type', () => {
  beforeEach(() => { db.legs = []; db.texts = []; });

  it('reads jl.vat_type with the legs', async () => {
    db.legs = [row('a', '1000.00', null)];
    await read(100, 15);
    expect(db.texts.find((t) => /AS journal_line_id/.test(t))).toMatch(/jl\.vat_type, jl\.credit - jl\.debit AS net/);
  });

  it('uncoded legs (a legacy invoice): one uncoded debit, pro rata, as before', async () => {
    db.legs = [row('a', '600.00', null), row('b', '400.00', null)];
    expect(await debits(500, 75)).toEqual([[500, null]]);
  });

  it('coded legs (a typed invoice): the note\'s VAT decides the rated part, each debit on its leg\'s type', async () => {
    db.legs = [row('s', '1000.00', 'standard'), row('z', '300.00', 'zero_rated'), row('e', '200.00', 'exempt')];
    expect(await debits(300, 15)).toEqual([[100, 'standard'], [120, 'zero_rated'], [80, 'exempt']]);
    await expect(read(1100, 165)).rejects.toBeInstanceOf(CreditNoteVatSplitRefusal);
  });

  it('a legacy spelling in jl.vat_type is not a stored type: the leg reads uncoded and the note splits as before', async () => {
    db.legs = [row('s', '1000.00', 'standard'), row('z', '1000.00', 'zero')];
    expect(await debits(200, 30)).toEqual([[100, 'standard'], [100, null]]);
  });
});
