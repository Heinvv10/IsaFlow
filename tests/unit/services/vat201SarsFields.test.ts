/**
 * The VAT201 on screen is the SARS form (FV V2016), field for field. The layout
 * below is transcribed from the official form (docs/sars/2026-07-VAT201-isv-dossier.md
 * s2a, Treasury VAT201 PDF): renumbering, relabelling or dropping a field
 * turns this red. The values come from the report service, never the page.
 */
import { describe, expect, it } from 'vitest';
import {
  VAT201_SARS_LAYOUT,
  buildVat201SarsFields,
  buildVat201Warnings,
} from '@/modules/accounting/services/reports/vat201SarsFields';
import type { Vat201Box, Vat201Report } from '@/modules/accounting/services/reports/vat201ReportService';

/** [field, SARS wording, kind]. Order is the order of the form. */
const SARS_FORM: ReadonlyArray<readonly [string, string, 'value' | 'tax']> = [
  ['1', 'Standard rate (excluding capital goods and/or services and accommodation)', 'value'],
  ['4', 'Output tax on field 1', 'tax'],
  ['1A', 'Standard rate (only capital goods and/or services)', 'value'],
  ['4A', 'Output tax on field 1A', 'tax'],
  ['2', 'Zero rate (excluding goods exported)', 'value'],
  ['2A', 'Zero rate (only exported goods)', 'value'],
  ['3', 'Exempt and non-supplies', 'value'],
  ['5', 'Accommodation exceeding 28 days', 'value'],
  ['6', 'Accommodation exceeding 28 days, taken into account (field 5 x percentage)', 'value'],
  ['7', 'Accommodation not exceeding 28 days', 'value'],
  ['8', 'Total accommodation (6 + 7)', 'value'],
  ['9', 'Output tax on accommodation (field 8)', 'tax'],
  ['10', 'Change in use and export of second-hand goods', 'value'],
  ['11', 'Output tax on change in use and export of second-hand goods (field 10)', 'tax'],
  ['12', 'Other and imported services', 'tax'],
  ['13', 'Total output tax (4 + 4A + 9 + 11 + 12)', 'tax'],
  ['14', 'Capital goods and/or services supplied to you', 'tax'],
  ['14A', 'Capital goods imported by you', 'tax'],
  ['15', 'Other goods and/or services supplied to you (not capital goods)', 'tax'],
  ['15A', 'Other goods imported by you (not capital goods)', 'tax'],
  ['16', 'Change in use', 'tax'],
  ['17', 'Bad debts', 'tax'],
  ['18', 'Other', 'tax'],
  ['19', 'Total input tax (14 + 14A + 15 + 15A + 16 + 17 + 18)', 'tax'],
  ['20', 'VAT payable / refundable (Total A - Total B)', 'tax'],
];

function box(boxNo: string, direction: 'output' | 'input', vatType: string, base: number, tax: number): Vat201Box {
  return { box: boxNo, label: boxNo, direction, vatType, base, tax, impliedTax: 0, variance: 0, lateClaimTax: 0 };
}

function report(boxes: Vat201Box[]): Pick<Vat201Report, 'boxes' | 'totals'> {
  const outputTax = boxes.filter((b) => b.direction === 'output').reduce((s, b) => s + b.tax, 0);
  const inputTax = boxes.filter((b) => b.direction === 'input').reduce((s, b) => s + b.tax, 0);
  return {
    boxes,
    totals: {
      outputTax, inputTax, netVat: Math.round((outputTax - inputTax) * 100) / 100,
      standardRatedSupplies: 0, standardRatedPurchases: 0, lateClaimInputTax: 0,
    },
  };
}

const NIL = {
  zeroRated: 0, exported: 0, exempt: 0, onTaxedJournals: 0, onTaxedCapital: 0, onTaxedAmbiguous: 0, uncodedAssumedZeroRated: 0,
};

function amounts(fields: ReturnType<typeof buildVat201SarsFields>): Record<string, number | null> {
  return Object.fromEntries(fields.map((f) => [f.field, f.amount]));
}

describe('VAT201 SARS layout (golden)', () => {
  it('carries exactly the official field numbers, labels and kinds', () => {
    expect(VAT201_SARS_LAYOUT.map((f) => [f.field, f.label, f.kind])).toEqual(SARS_FORM.map((f) => [...f]));
  });

  it('has no duplicate field number', () => {
    const numbers = VAT201_SARS_LAYOUT.map((f) => f.field);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('emits every layout field, in layout order, whatever the period holds', () => {
    const fields = buildVat201SarsFields(report([]), NIL);
    expect(fields.map((f) => f.field)).toEqual(SARS_FORM.map((f) => f[0]));
  });
});

describe('buildVat201SarsFields values', () => {
  it('reads each field from the report boxes and totals', () => {
    const r = report([
      box('1', 'output', 'standard', 10000, 1500),
      box('1A', 'output', 'capital_goods', 2000, 300),
      box('12', 'output', 'reverse_charge', 100, 15),
      box('14', 'input', 'capital_goods', 4000, 600),
      box('15', 'input', 'standard', 6000, 900),
      box('14A/15A', 'input', 'imported', 800, 120),
      box('16', 'input', 'reverse_charge', 0, 10),
      box('17', 'input', 'bad_debt', 0, 20),
    ]);
    const a = amounts(buildVat201SarsFields(r, { ...NIL, zeroRated: 1200, exported: 700, exempt: 300 }));
    expect(a).toMatchObject({
      '1': 11500, '4': 1500, '1A': 2300, '4A': 300,
      '2': 500, '2A': 700, '3': 300,
      '12': 15, '13': 1815,
      '14': 600, '15': 910, '15A': 120, '17': 20, '18': 0,
      '19': 1650, '20': 165,
    });
  });

  it('gives the nil-rated share of a taxed journal back from field 1', () => {
    const r = report([box('1', 'output', 'standard', 10000, 1500)]);
    const a = amounts(buildVat201SarsFields(r, { ...NIL, zeroRated: 500, onTaxedJournals: 500 }));
    expect(a['1']).toBe(11000);
    expect(a['2']).toBe(500);
  });

  it('states supply values VAT-inclusive, so field 4 is field 1 x r/(100+r)', () => {
    const r = report([box('1', 'output', 'standard', 10000, 1500)]);
    const a = amounts(buildVat201SarsFields(r, NIL));
    expect(a['1']).toBe(11500);
    expect(Math.round(((a['1'] ?? 0) * 15) / 115 * 100) / 100).toBe(a['4']);
  });

  it('reports zero-rated domestic supplies net of exports, so 2 and 2A never double count', () => {
    const a = amounts(buildVat201SarsFields(report([]), { ...NIL, zeroRated: 1200, exported: 700 }));
    expect(a['2']).toBe(500);
    expect(a['2A']).toBe(700);
  });

  it('puts output tax on any unmapped box into field 12 so 13 still equals 4 + 4A + 12', () => {
    const r = report([
      box('1', 'output', 'standard', 1000, 150),
      box('unclassified', 'output', 'weird', 100, 40),
    ]);
    const a = amounts(buildVat201SarsFields(r, NIL));
    expect(a['12']).toBe(40);
    expect(a['13']).toBe(190);
    expect((a['4'] ?? 0) + (a['4A'] ?? 0) + (a['12'] ?? 0)).toBe(a['13']);
  });

  it('puts input tax on any unmapped box into field 18 so 19 still equals the sum of its parts', () => {
    const r = report([
      box('15', 'input', 'standard', 1000, 150),
      box('18', 'input', 'no_vat', 0, 5),
      box('unclassified', 'input', 'weird', 0, 7),
    ]);
    const a = amounts(buildVat201SarsFields(r, NIL));
    expect(a['18']).toBe(12);
    expect(a['19']).toBe(162);
  });

  it('does not invent figures for what IsaFlow does not track: accommodation, second-hand goods, 14A', () => {
    const a = amounts(buildVat201SarsFields(report([]), NIL));
    for (const untracked of ['5', '6', '7', '8', '9', '10', '11', '14A', '16']) expect(a[untracked]).toBeNull();
  });

  it('flags the fields it cannot fill, with a reason', () => {
    const fields = buildVat201SarsFields(report([]), NIL);
    const untracked = fields.filter((f) => f.amount === null);
    expect(untracked.length).toBeGreaterThan(0);
    for (const f of untracked) expect(f.note).toBeTruthy();
  });

  it('books domestic reverse charge INPUT tax in field 15 with the other claims, never field 16', () => {
    const r = report([
      box('15', 'input', 'standard', 1000, 150),
      box('16', 'input', 'reverse_charge', 400, 60),
    ]);
    const fields = buildVat201SarsFields(r, NIL);
    const a = amounts(fields);
    expect(a['15']).toBe(210);
    expect(a['16']).toBeNull();
    expect(a['19']).toBe(210);
    expect(fields.find((f) => f.field === '15')?.note).toMatch(/domestic reverse charge input tax/);
    expect(fields.find((f) => f.field === '15')?.note).toMatch(/UNVERIFIED: SARS DRC guide not on file/);
  });

  it('keeps domestic reverse charge OUTPUT tax in field 12 and says so', () => {
    const r = report([box('12', 'output', 'reverse_charge', 400, 60)]);
    const fields = buildVat201SarsFields(r, NIL);
    expect(amounts(fields)['12']).toBe(60);
    expect(fields.find((f) => f.field === '12')?.note).toMatch(/domestic reverse charge output tax/);
  });

  it('takes the nil-rated share of an all-capital journal off 1A, not 1', () => {
    const r = report([
      box('1', 'output', 'standard', 10000, 1500),
      box('1A', 'output', 'capital_goods', 5000, 750),
    ]);
    const a = amounts(buildVat201SarsFields(r, { ...NIL, zeroRated: 500, onTaxedJournals: 500, onTaxedCapital: 500 }));
    expect(a['1']).toBe(11500);
    expect(a['1A']).toBe(5250);
  });

  it('cautions on 2A that exported services belong in field 2', () => {
    const fields = buildVat201SarsFields(report([]), NIL);
    expect(fields.find((f) => f.field === '2A')?.note).toMatch(/exported services, which belong in field 2/);
  });

  it('keeps a negative total (a refund) negative on field 20', () => {
    const r = report([box('1', 'output', 'standard', 100, 15), box('15', 'input', 'standard', 1000, 150)]);
    expect(amounts(buildVat201SarsFields(r, NIL))['20']).toBe(-135);
  });
});

describe('buildVat201Warnings', () => {
  const none = (nil = NIL) => buildVat201Warnings(buildVat201SarsFields(report([]), nil), nil);

  it('is silent when nothing needs a second look', () => {
    expect(none()).toEqual([]);
  });

  it('warns on a negative supply value, naming the field', () => {
    const r = report([box('1', 'output', 'standard', -1000, -150)]);
    const w = buildVat201Warnings(buildVat201SarsFields(r, NIL), NIL);
    expect(w.map((x) => x.code)).toEqual(['negative-supply-value']);
    expect(w[0]!.message).toMatch(/Field 1 is negative/);
  });

  it('warns when a nil-rated line sits on a journal mixing capital and other taxed output', () => {
    const nil = { ...NIL, zeroRated: 300, onTaxedJournals: 300, onTaxedAmbiguous: 300 };
    const r = report([box('1', 'output', 'standard', 10000, 1500)]);
    expect(buildVat201Warnings(buildVat201SarsFields(r, nil), nil).map((x) => x.code)).toEqual(['mixed-capital-and-nil-rated']);
  });

  it('warns when uncoded revenue was assumed zero-rated, with the amount', () => {
    const nil = { ...NIL, zeroRated: 800, uncodedAssumedZeroRated: 800 };
    const w = none(nil);
    expect(w.map((x) => x.code)).toEqual(['uncoded-revenue-assumed-zero-rated']);
    expect(w[0]!.amount).toBe(800);
  });
});
