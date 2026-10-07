/**
 * The revenue half of a customer invoice journal, and the revenue half of a
 * credit note that reverses one. Pure, so every allocation rule is pinned here
 * and proven to balance against the REAL journal validator.
 */
import { describe, it, expect } from 'vitest';
import {
  allocateByWeight,
  buildInvoiceRevenueLines,
  prorateRevenueLegs,
  revenueLinesInconsistency,
  type StoredRevenueLine,
} from '@/modules/accounting/services/ar/invoiceRevenueLines';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const DEFAULT = 'acct-default-revenue';
const COMMERCIALS = 'acct-commercials';
const POST = 'acct-post-production';
const P1 = 'project-1';
const P2 = 'project-2';
const CC = 'centre-1';

const line = (amount: number, glAccountId: string | null = null, projectId: string | null = null,
  costCenterId: string | null = null): StoredRevenueLine => ({ amount, glAccountId, projectId, costCenterId });

const build = (lines: StoredRevenueLine[], documentSubtotal: number, credit = documentSubtotal) =>
  buildInvoiceRevenueLines({ invoiceNumber: 'INV-1', documentSubtotal, credit, lines, defaultRevenueAccountId: DEFAULT });

const balances = (revenue: JournalLineInput[], total: number) => validateJournalEntry([
  { glAccountId: 'acct-ar', debit: total, credit: 0 }, ...revenue,
]).valid;

describe('buildInvoiceRevenueLines — no line coded (every existing invoice)', () => {
  it('is exactly the single default_revenue leg posted today', () => {
    expect(build([line(60), line(40)], 100)).toEqual([
      { glAccountId: DEFAULT, debit: 0, credit: 100, description: 'Revenue: INV-1' },
    ]);
  });

  it('does not read the line amounts at all — a header that disagrees with its lines posts as today', () => {
    expect(build([line(5)], 100)).toEqual([
      { glAccountId: DEFAULT, debit: 0, credit: 100, description: 'Revenue: INV-1' },
    ]);
  });

  it('an invoice with no lines posts as today', () => {
    expect(build([], 250)).toEqual([
      { glAccountId: DEFAULT, debit: 0, credit: 250, description: 'Revenue: INV-1' },
    ]);
  });
});

describe('buildInvoiceRevenueLines — coded lines', () => {
  it('credits each (account, project, cost centre) group its own lines, uncoded lines to default_revenue', () => {
    const lines = build([
      line(1000, COMMERCIALS, P1),
      line(500, COMMERCIALS, P1),
      line(300, POST, P2, CC),
      line(200),
    ], 2000);
    expect(lines).toEqual([
      { glAccountId: COMMERCIALS, debit: 0, credit: 1500, description: 'Revenue: INV-1', projectId: P1, costCenterId: undefined },
      { glAccountId: POST, debit: 0, credit: 300, description: 'Revenue: INV-1', projectId: P2, costCenterId: CC },
      { glAccountId: DEFAULT, debit: 0, credit: 200, description: 'Revenue: INV-1', projectId: undefined, costCenterId: undefined },
    ]);
    expect(balances(lines, 2000)).toBe(true);
  });

  it('a project alone, with no account, credits default_revenue tagged to the project', () => {
    expect(build([line(100, null, P1)], 100)).toEqual([
      { glAccountId: DEFAULT, debit: 0, credit: 100, description: 'Revenue: INV-1', projectId: P1, costCenterId: undefined },
    ]);
  });

  it('the same account and project on two cost centres is two legs', () => {
    expect(build([line(70, COMMERCIALS, P1, CC), line(30, COMMERCIALS, P1, 'centre-2')], 100)
      .map((l) => [l.costCenterId, l.credit])).toEqual([[CC, 70], ['centre-2', 30]]);
  });

  it('the same account on two projects is two legs', () => {
    expect(build([line(70, COMMERCIALS, P1), line(30, COMMERCIALS, P2)], 100).map((l) => [l.projectId, l.credit]))
      .toEqual([[P1, 70], [P2, 30]]);
  });

  it('absorbs a rounding residual into the largest group, so credits equal the subtotal to the cent', () => {
    const lines = build([line(33.33, COMMERCIALS), line(33.33, POST), line(33.33)], 100);
    expect(lines.reduce((s, l) => s + l.credit, 0)).toBeCloseTo(100, 10);
    expect(lines.map((l) => l.credit)).toEqual([33.34, 33.33, 33.33]);
    expect(balances(lines, 100)).toBe(true);
  });

  it('allocates the posted amount by line weight when it differs from the document subtotal', () => {
    // credit is the amount the journal carries (a functional-currency figure
    // after the FX work); the lines only decide the split.
    const lines = build([line(75, COMMERCIALS, P1), line(25, POST, P2)], 100, 1850.37);
    expect(lines.map((l) => l.credit)).toEqual([1387.78, 462.59]);
    expect(balances(lines, 1850.37)).toBe(true);
  });

  it('posts a group that nets negative as a debit on its own account and project', () => {
    const lines = build([line(1000, COMMERCIALS, P1), line(-100, POST, P1)], 900);
    expect(lines).toEqual([
      { glAccountId: COMMERCIALS, debit: 0, credit: 1000, description: 'Revenue: INV-1', projectId: P1, costCenterId: undefined },
      { glAccountId: POST, debit: 100, credit: 0, description: 'Revenue: INV-1', projectId: P1, costCenterId: undefined },
    ]);
    expect(balances(lines, 900)).toBe(true);
  });

  it('drops a group that nets to zero', () => {
    expect(build([line(100, COMMERCIALS), line(50, POST), line(-50, POST)], 100).map((l) => l.glAccountId))
      .toEqual([COMMERCIALS]);
  });

  it('refuses lines that do not add up to the subtotal, rather than post a split nobody entered', () => {
    expect(() => build([line(60, COMMERCIALS), line(30)], 100)).toThrow(InvoiceLineCodingRefusal);
    expect(() => build([line(60, COMMERCIALS), line(30)], 100)).toThrow(/INV-1.*90\.00.*100\.00/);
  });

  it('refuses coded lines whose weights total zero or less', () => {
    expect(() => build([line(50, COMMERCIALS), line(-50)], 0)).toThrow(InvoiceLineCodingRefusal);
  });
});

describe('revenueLinesInconsistency', () => {
  it('allows one cent per line of rounding either way', () => {
    expect(revenueLinesInconsistency([line(33.33), line(33.33), line(33.33)], 100)).toBeNull();
    expect(revenueLinesInconsistency([line(33.34), line(33.34), line(33.34)], 100)).toBeNull();
  });

  it('refuses more than one cent per line', () => {
    expect(revenueLinesInconsistency([line(33.33), line(33.33)], 66.69)).toMatch(/66\.66.*66\.69/);
  });
});

describe('allocateByWeight', () => {
  it('splits exactly, residual to the largest weight (first on a tie)', () => {
    expect(allocateByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateByWeight(1000, [1, 3])).toEqual([250, 750]);
  });

  it('gives the residual to the largest weight even when it is not first', () => {
    // 1/7 and 6/7 of 100: 14.29 + 85.71 rounds to 14 + 86 = 100 here; force a residual with three.
    expect(allocateByWeight(100, [1, 1, 4])).toEqual([17, 17, 66]);
    expect(allocateByWeight(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateByWeight(10, [1, 3, 1])).toEqual([2, 6, 2]);
  });

  it('keeps the sign of a negative weight', () => {
    const out = allocateByWeight(900, [1000, -100]);
    expect(out).toEqual([1000, -100]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(900);
  });
});

describe('prorateRevenueLegs — a credit note reverses where the invoice posted, never past it', () => {
  const legs = [
    { glAccountId: COMMERCIALS, projectId: P1, costCenterId: null, net: 1500 },
    { glAccountId: POST, projectId: P2, costCenterId: CC, net: 500 },
  ];
  const prorate = (l: Parameters<typeof prorateRevenueLegs>[0], amount: number) => prorateRevenueLegs(l, amount, 'CN-1', DEFAULT);
  const debits = (lines: JournalLineInput[]) => lines.map((l) => [l.glAccountId, l.projectId ?? null, l.debit - l.credit]);

  it('debits each revenue leg pro rata to the note', () => {
    expect(prorate(legs, 400)).toEqual([
      { glAccountId: COMMERCIALS, debit: 300, credit: 0, description: 'Credit note CN-1', projectId: P1, costCenterId: undefined },
      { glAccountId: POST, debit: 100, credit: 0, description: 'Credit note CN-1', projectId: P2, costCenterId: CC },
    ]);
  });

  it('a full credit reverses every leg exactly', () => {
    expect(debits(prorate(legs, 2000))).toEqual([[COMMERCIALS, P1, 1500], [POST, P2, 500]]);
  });

  it('a note larger than the invoice (1500 on 1000) fills every leg and puts the rest on default_revenue, untagged', () => {
    const out = prorate([
      { glAccountId: COMMERCIALS, projectId: P1, costCenterId: null, net: 750 },
      { glAccountId: POST, projectId: P2, costCenterId: null, net: 250 },
    ], 1500);
    expect(debits(out)).toEqual([[COMMERCIALS, P1, 750], [POST, P2, 250], [DEFAULT, null, 500]]);
    expect(out[2]).toMatchObject({ projectId: undefined, costCenterId: undefined });
  });

  it('a second full note, after the first took everything, goes wholly to default_revenue', () => {
    expect(debits(prorate(legs.map((l) => ({ ...l, net: 0 })), 2000))).toEqual([[DEFAULT, null, 2000]]);
  });

  it('two notes of 50 on legs of 0.01 and 99.99 never leave a leg below zero', () => {
    const first = prorate([
      { glAccountId: COMMERCIALS, projectId: P1, costCenterId: null, net: 0.01 },
      { glAccountId: POST, projectId: P2, costCenterId: null, net: 99.99 },
    ], 50);
    const took = new Map(first.map((l) => [l.glAccountId, l.debit]));
    const second = prorate([
      { glAccountId: COMMERCIALS, projectId: P1, costCenterId: null, net: Math.round((0.01 - (took.get(COMMERCIALS) ?? 0)) * 100) / 100 },
      { glAccountId: POST, projectId: P2, costCenterId: null, net: Math.round((99.99 - (took.get(POST) ?? 0)) * 100) / 100 },
    ], 50);
    for (const account of [COMMERCIALS, POST]) {
      const all = [...first, ...second].filter((l) => l.glAccountId === account).reduce((s, l) => s + l.debit - l.credit, 0);
      expect(Math.round(all * 100)).toBeLessThanOrEqual(account === COMMERCIALS ? 1 : 9999);
    }
    expect([...first, ...second].reduce((s, l) => s + l.debit, 0)).toBeCloseTo(100, 10);
  });

  it('clamps a rounding cent that would push a small leg past what it carries', () => {
    // 1 cent of 3 on a leg of 0.01: allocateByWeight gives it a cent it may keep, never two.
    const out = prorate([
      { glAccountId: COMMERCIALS, projectId: null, costCenterId: null, net: 0.01 },
      { glAccountId: POST, projectId: null, costCenterId: null, net: 0.01 },
    ], 0.01);
    expect(out.reduce((s, l) => s + l.debit, 0)).toBeCloseTo(0.01, 10);
    expect(out.every((l) => l.debit <= 0.01)).toBe(true);
  });

  it('a leg the invoice posted as a debit (a discount) is credited back pro rata', () => {
    const out = prorate([
      { glAccountId: COMMERCIALS, projectId: P1, costCenterId: null, net: 1000 },
      { glAccountId: POST, projectId: P1, costCenterId: null, net: -100 },
    ], 450);
    expect(out.map((l) => [l.debit, l.credit])).toEqual([[500, 0], [0, 50]]);
    expect(validateJournalEntry([...out, { glAccountId: 'acct-ar', debit: 0, credit: 450 }]).valid).toBe(true);
  });

  it('legs netting to nothing, or none at all, put the whole note on default_revenue', () => {
    expect(debits(prorate([], 100))).toEqual([[DEFAULT, null, 100]]);
    expect(debits(prorate([{ glAccountId: POST, projectId: null, costCenterId: null, net: -5 }], 100))).toEqual([[DEFAULT, null, 100]]);
  });
});
