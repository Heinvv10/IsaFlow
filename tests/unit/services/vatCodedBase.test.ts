/**
 * The coded-base rule (reports/vatCodedBase): in a journal with an input tax
 * leg and no output leg, once any base line carries a TAXED code, the base the
 * 15% check is run on is the taxed-coded lines only — uncoded and
 * zero_rated/export/exempt/no_vat lines are not the supply the tax is on.
 */
import { describe, expect, it } from 'vitest';
import { applyCodedBaseRule } from '@/modules/accounting/services/reports/vatCodedBase';
import type { VatLineInput } from '@/modules/accounting/services/reports/vatBoxBasis';

let n = 0;
const line = (je: string, over: Partial<VatLineInput>): VatLineInput => ({
  journalEntryId: je, entryNumber: je, entryDate: '2026-09-10', lineId: `l${++n}`,
  accountId: 'exp', accountCode: '6000', accountName: 'Expense', accountType: 'expense',
  accountSubtype: 'operating_expense', vatType: null, debit: 0, credit: 0, cancelledSource: false,
  ...over,
});
const vatIn = (je: string, debit: number, vatType = 'standard') =>
  line(je, { accountId: 'vin', accountType: 'asset', accountSubtype: 'vat_input', vatType, debit });
const vatOut = (je: string, credit: number) =>
  line(je, { accountId: 'vout', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit });
const bank = (je: string, credit: number, debit = 0) =>
  line(je, { accountId: 'bank', accountType: 'asset', accountSubtype: 'bank', credit, debit });
const ids = (ls: VatLineInput[]) => ls.map((l) => l.lineId);

describe('applyCodedBaseRule', () => {
  it('a mixed journal: a taxed-coded base line drops the uncoded and untaxed-coded base lines', () => {
    const coded = line('mix', { debit: 1000, vatType: 'standard' });
    const uncoded = line('mix', { debit: 5000 });
    const zero = line('mix', { debit: 300, vatType: 'zero_rated' });
    const exempt = line('mix', { debit: 200, vatType: 'exempt' });
    const tax = vatIn('mix', 150);
    const settle = bank('mix', 6650);
    const kept = applyCodedBaseRule([coded, uncoded, zero, exempt, tax, settle]);
    expect(ids(kept)).toEqual(ids([coded, tax, settle]));
  });

  it('keeps every taxed code, not only standard (capital_goods, imported)', () => {
    const cap = line('cap', { debit: 1000, vatType: 'capital_goods' });
    const imp = line('cap', { debit: 400, vatType: 'imported' });
    const noVat = line('cap', { debit: 50, vatType: 'no_vat' });
    const all = [cap, imp, noVat, vatIn('cap', 210, 'capital_goods'), bank('cap', 1660)];
    expect(ids(applyCodedBaseRule(all))).toEqual(ids(all.filter((l) => l !== noVat)));
  });

  it('an ordinary bill (expense lines carry no code) is unchanged', () => {
    const bill = [line('bill', { debit: 1000 }), line('bill', { debit: 250 }), vatIn('bill', 187.5),
      line('bill', { accountId: 'ap', accountType: 'liability', accountSubtype: 'payable', credit: 1437.5 })];
    expect(applyCodedBaseRule(bill)).toEqual(bill);
  });

  it('a bill with a zero-rated item and no taxed-coded line is unchanged', () => {
    const bill = [line('zr', { debit: 1000 }), line('zr', { debit: 500, vatType: 'zero_rated' }),
      vatIn('zr', 150), bank('zr', 1650)];
    expect(applyCodedBaseRule(bill)).toEqual(bill);
  });

  it('a journal with an OUTPUT leg is untouched, even with an input leg and coded base', () => {
    const sale = [line('out', { accountType: 'revenue', accountSubtype: 'sales', credit: 1000, vatType: 'standard' }),
      line('out', { accountType: 'revenue', accountSubtype: 'sales', credit: 800 }),
      vatOut('out', 150), vatIn('out', 30), line('out', { debit: 200, vatType: 'standard' }), bank('out', 0, 1720)];
    expect(applyCodedBaseRule(sale)).toEqual(sale);
  });

  it('applies per journal: a coded journal does not strip lines from its neighbour', () => {
    const a = [line('a', { debit: 1000, vatType: 'standard' }), line('a', { debit: 9000 }), vatIn('a', 150), bank('a', 10150)];
    const b = [line('b', { debit: 2000 }), vatIn('b', 300), bank('b', 2300)];
    expect(ids(applyCodedBaseRule([...a, ...b]))).toEqual(ids([a[0]!, a[2]!, a[3]!, ...b]));
  });

  it('never drops tax, settlement, cancelled or unmapped lines', () => {
    const unmapped = line('u', { accountId: 'sys9', accountType: 'liability', accountSubtype: null, vatType: 'standard', credit: 10 });
    const js = [line('u', { debit: 100, vatType: 'standard' }), line('u', { debit: 900 }), vatIn('u', 15), unmapped, bank('u', 1005)];
    expect(ids(applyCodedBaseRule(js))).toEqual(ids(js.filter((l) => l !== js[1])));
  });
});
