/**
 * creditNoteRevenueJournalLines reads the invoice journal's revenue legs WITH their vat_type (PR #1648 review T4):
 * coded legs give the note's debits their type and route a typed invoice through the VAT split
 * (creditNoteTypedSplit); uncoded legs, or a spelling the ledger does not store ('zero'), stay uncoded and the note
 * splits pro rata over every leg exactly as before. `sql` is answered by statement, not call order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ legs: [] as Record<string, unknown>[], vat: [] as Record<string, unknown>[],
  taken: [] as Record<string, unknown>[], texts: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[]) => {
    const text = strings.join('?');
    db.texts.push(text);
    if (/AS journal_line_id, jl\.gl_account_id/.test(text)) return db.legs;
    if (/AS invoice_vat/.test(text)) return db.vat;
    if (/SUM\(a\.amount\) AS amount/.test(text)) return db.taken;
    return []; // nothing taken by earlier notes; no pre-874 notes
  }),
}));

import { creditNoteRevenueJournalLines, typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';

const DEFAULT = 'acct-default';
const row = (id: string, net: string, vatType: string | null) => ({
  journal_line_id: id, gl_account_id: 'acct-sales', is_active: true, project_id: null, cc1_id: null, cc2_id: null, bu_id: null,
  vat_type: vatType, net,
});
const NO_TAGS = { projectId: null, cc1Id: null, cc2Id: null, buId: null };
const read = (amount: number, taxAmount: number) => creditNoteRevenueJournalLines('co', {
  id: 'cn', number: 'CN-1', amount, taxAmount, customerInvoiceId: 'inv', tags: NO_TAGS,
}, DEFAULT);
const debits = async (amount: number, taxAmount: number) => (await read(amount, taxAmount)).lines.map((l) => [l.debit, l.vatType ?? null]);

describe('creditNoteRevenueJournalLines and the invoice legs\' vat_type', () => {
  beforeEach(() => { db.legs = []; db.vat = []; db.taken = []; db.texts = []; });

  it('reads jl.vat_type with the legs', async () => {
    db.legs = [row('a', '1000.00', null)];
    await read(100, 15);
    expect(db.texts.find((t) => /AS journal_line_id/.test(t))).toMatch(/jl\.vat_type, jl\.credit - jl\.debit AS net/);
  });

  it('uncoded legs (a legacy invoice): one uncoded debit, pro rata, as before', async () => {
    db.legs = [row('a', '600.00', null), row('b', '400.00', null)];
    expect(await debits(500, 75)).toEqual([[500, null]]);
  });

  it('coded legs (a typed invoice): pro rata over every leg, each debit on its leg\'s type, VAT exactly proportional', async () => {
    db.legs = [row('s', '1000.00', 'standard'), row('z', '300.00', 'zero_rated'), row('e', '200.00', 'exempt')];
    db.vat = [{ invoice_vat: '150.00', reversed_vat: '0.00' }];
    expect(await debits(300, 30)).toEqual([[200, 'standard'], [60, 'zero_rated'], [40, 'exempt']]);
    await expect(read(300, 45)).rejects.toThrow(/its VAT must be 30\.00, not 45\.00/);
    await expect(read(1100, 165)).rejects.toBeInstanceOf(CreditNoteVatSplitRefusal);
  });

  it('a legacy spelling in jl.vat_type is not a stored type: the leg reads uncoded and the note splits as before', async () => {
    db.legs = [row('s', '1000.00', 'standard'), row('z', '1000.00', 'zero')];
    expect(await debits(200, 30)).toEqual([[100, 'standard'], [100, null]]);
  });

  it('a typed invoice: reads its remaining VAT, and a note clearing the net carries all of it', async () => {
    db.legs = [row('s', '66.66', 'standard'), row('e', '100.00', 'exempt')];
    db.vat = [{ invoice_vat: '10.00', reversed_vat: '0.00' }];
    expect(await debits(166.66, 10)).toEqual([[66.66, 'standard'], [100, 'exempt']]);
    expect(db.texts.find((t) => /AS invoice_vat/.test(t))).toMatch(/vat_output[\s\S]*SUM\(cn\.tax_amount\)/);
  });

  it('a legacy invoice does not read it', async () => {
    db.legs = [row('a', '1000.00', null)];
    await read(100, 15);
    expect(db.texts.some((t) => /AS invoice_vat/.test(t))).toBe(false);
  });

  // The remaining VAT is the invoice's VAT less what its live earlier notes reversed. On the hundred R0.10-lines invoice
  // (10.00 standard carrying 2.00, 50 exempt) an earlier 12.00 + 0.40 note took 2.00 and 10.00: 48.00 and 1.60 remain.
  it('subtracts the earlier notes\' VAT: the final 48.00 + 1.60 takes standard 8.00 and exempt 40', async () => {
    db.legs = [row('s', '10.00', 'standard'), row('e', '50.00', 'exempt')];
    db.taken = [{ journal_line_id: 's', amount: '2.00' }, { journal_line_id: 'e', amount: '10.00' }];
    db.vat = [{ invoice_vat: '2.00', reversed_vat: '0.40' }];
    expect(await debits(48, 1.6)).toEqual([[8, 'standard'], [40, 'exempt']]);
  });

  it('without that subtraction the same note reads differently: refused, it would have to carry 2.00', async () => {
    db.legs = [row('s', '10.00', 'standard'), row('e', '50.00', 'exempt')];
    db.taken = [{ journal_line_id: 's', amount: '2.00' }, { journal_line_id: 'e', amount: '10.00' }];
    db.vat = [{ invoice_vat: '2.00', reversed_vat: '0.00' }];
    await expect(read(48, 1.6)).rejects.toThrow(/its VAT must be 2\.00, not 1\.60/);
  });

  it('what a typed invoice still has to credit, for a dispute raising a note against it', async () => {
    db.legs = [row('s', '10.00', 'standard'), row('e', '50.00', 'exempt')];
    db.taken = [{ journal_line_id: 's', amount: '2.00' }, { journal_line_id: 'e', amount: '10.00' }];
    db.vat = [{ invoice_vat: '2.00', reversed_vat: '0.40' }];
    expect(await typedInvoiceCreditState('co', 'inv')).toEqual({ remainingNet: 48, remainingVat: 1.6 });
    db.legs = [row('a', '1000.00', null)];
    expect(await typedInvoiceCreditState('co', 'inv')).toBeNull();
  });

  it('counts only live earlier customer notes, never this one', async () => {
    db.legs = [row('s', '10.00', 'standard')];
    db.vat = [{ invoice_vat: '2.00', reversed_vat: '0.00' }];
    await read(10, 2);
    expect(db.texts.find((t) => /AS invoice_vat/.test(t)))
      .toMatch(/cn\.type = 'customer' AND cn\.status NOT IN \('draft', 'cancelled'\) AND cn\.id <> \?::UUID/);
  });
});
