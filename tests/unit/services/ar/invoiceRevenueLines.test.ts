/**
 * The revenue half of a customer invoice journal, and the revenue half of a
 * credit note that reverses one. Pure, so every allocation rule is pinned here
 * and proven to balance against the REAL journal validator.
 */
import { describe, it, expect } from 'vitest';
import {
  allocateByWeight,
  buildInvoiceRevenueLines,
  allocateCreditNote,
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
  cc2Id: string | null = null): StoredRevenueLine => ({ amount, glAccountId, projectId, ...(cc2Id ? { cc2Id } : {}) });

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
  it('credits each (account, job, CC1, CC2, BU) group its own lines, uncoded lines to default_revenue', () => {
    const lines = build([
      line(1000, COMMERCIALS, P1),
      line(500, COMMERCIALS, P1),
      line(300, POST, P2, CC),
      line(200),
    ], 2000);
    expect(lines).toEqual([
      { glAccountId: COMMERCIALS, debit: 0, credit: 1500, description: 'Revenue: INV-1', projectId: P1, cc2Id: undefined },
      { glAccountId: POST, debit: 0, credit: 300, description: 'Revenue: INV-1', projectId: P2, cc2Id: CC },
      { glAccountId: DEFAULT, debit: 0, credit: 200, description: 'Revenue: INV-1', projectId: undefined, cc2Id: undefined },
    ]);
    expect(balances(lines, 2000)).toBe(true);
  });

  it('a project alone, with no account, credits default_revenue tagged to the project', () => {
    expect(build([line(100, null, P1)], 100)).toEqual([
      { glAccountId: DEFAULT, debit: 0, credit: 100, description: 'Revenue: INV-1', projectId: P1, cc2Id: undefined },
    ]);
  });

  it('the same account and job on two CC2 projects is two legs', () => {
    expect(build([line(70, COMMERCIALS, P1, CC), line(30, COMMERCIALS, P1, 'centre-2')], 100)
      .map((l) => [l.cc2Id, l.credit])).toEqual([[CC, 70], ['centre-2', 30]]);
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
      { glAccountId: COMMERCIALS, debit: 0, credit: 1000, description: 'Revenue: INV-1', projectId: P1, cc2Id: undefined },
      { glAccountId: POST, debit: 100, credit: 0, description: 'Revenue: INV-1', projectId: P1, cc2Id: undefined },
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
    { glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 1500 },
    { glAccountId: POST, projectId: P2, cc1Id: null, cc2Id: CC, buId: null, net: 500 },
  ];
  const prorate = (l: Parameters<typeof prorateRevenueLegs>[0], amount: number) => prorateRevenueLegs(l, amount, 'CN-1', DEFAULT);
  const debits = (lines: JournalLineInput[]) => lines.map((l) => [l.glAccountId, l.projectId ?? null, l.debit - l.credit]);

  it('debits each revenue leg pro rata to the note', () => {
    expect(prorate(legs, 400)).toEqual([
      { glAccountId: COMMERCIALS, debit: 300, credit: 0, description: 'Credit note CN-1', projectId: P1, cc2Id: undefined },
      { glAccountId: POST, debit: 100, credit: 0, description: 'Credit note CN-1', projectId: P2, cc2Id: CC },
    ]);
  });

  it('a full credit reverses every leg exactly', () => {
    expect(debits(prorate(legs, 2000))).toEqual([[COMMERCIALS, P1, 1500], [POST, P2, 500]]);
  });

  it('a note larger than the invoice (1500 on 1000) fills every leg and puts the rest on default_revenue, untagged', () => {
    const out = prorate([
      { glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 750 },
      { glAccountId: POST, projectId: P2, cc1Id: null, cc2Id: null, buId: null, net: 250 },
    ], 1500);
    expect(debits(out)).toEqual([[COMMERCIALS, P1, 750], [POST, P2, 250], [DEFAULT, null, 500]]);
    expect(out[2]).toMatchObject({ projectId: undefined, cc2Id: undefined });
  });

  it('a second full note, after the first took everything, goes wholly to default_revenue', () => {
    expect(debits(prorate(legs.map((l) => ({ ...l, net: 0 })), 2000))).toEqual([[DEFAULT, null, 2000]]);
  });

  it('two notes of 50 on legs of 0.01 and 99.99 never leave a leg below zero', () => {
    const legs2 = [
      { glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 0.01 },
      { glAccountId: POST, projectId: P2, cc1Id: null, cc2Id: null, buId: null, net: 99.99 },
    ];
    const first = prorateRevenueLegs(legs2, 50, 'CN-1', DEFAULT);
    const second = prorateRevenueLegs(legs2, 50, 'CN-2', DEFAULT, [50]);
    for (const account of [COMMERCIALS, POST]) {
      const all = [...first, ...second].filter((l) => l.glAccountId === account).reduce((s, l) => s + l.debit - l.credit, 0);
      expect(Math.round(all * 100)).toBeLessThanOrEqual(account === COMMERCIALS ? 1 : 9999);
    }
    expect([...first, ...second].reduce((s, l) => s + l.debit, 0)).toBeCloseTo(100, 10);
  });

  it('replays earlier notes with the same rule, by leg identity, in the order given', () => {
    // 600/400; earlier notes of 500 and 300 took 300/200 then 180/120: 120/80 is left.
    const legs2 = [
      { glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 600 },
      { glAccountId: POST, projectId: P2, cc1Id: null, cc2Id: null, buId: null, net: 400 },
    ];
    expect(debits(prorateRevenueLegs(legs2, 1000, 'CN-3', DEFAULT, [500, 300])))
      .toEqual([[COMMERCIALS, P1, 120], [POST, P2, 80], [DEFAULT, null, 800]]);
  });

  it('replays pre-873 notes in approval order: two unequal notes on uneven legs, swapped, leave different legs', () => {
    // Found by search. Rounding makes the replay order-sensitive, so the order is the approval order.
    const legs3 = [0.33, 0.25, 0.01].map((net, i) => ({ glAccountId: `acct-${i}`, projectId: null, cc1Id: null, cc2Id: null, buId: null, net }));
    const took = (earlier: number[]) => allocateCreditNote(legs3, 0.33, 'CN-3', DEFAULT, earlier).allocations
      .map((a) => [a.glAccountId, a.amount, a.isExcess]);
    expect(took([0.29, 0.05])).toEqual([['acct-0', 0.13, false], ['acct-1', 0.11, false], ['acct-2', 0.01, false], [DEFAULT, 0.08, true]]);
    expect(took([0.05, 0.29])).toEqual([['acct-0', 0.14, false], ['acct-1', 0.11, false], [DEFAULT, 0.08, true]]);
  });

  it('subtracts what live notes RECORDED (taken) after the replay, and never takes a leg past zero', () => {
    const legs2 = [
      { glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 600, taken: 100, journalLineId: 'l1' },
      { glAccountId: POST, projectId: P2, cc1Id: null, cc2Id: null, buId: null, net: 400, taken: 500, journalLineId: 'l2' },
    ];
    // Replayed 500 takes 300/200 → 300/200 left; recorded 100/500 → 200/0 (clamped, not −300).
    expect(allocateCreditNote(legs2, 1000, 'CN-3', DEFAULT, [500]).allocations).toEqual([
      { journalLineId: 'l1', glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, amount: 200, isExcess: false },
      { journalLineId: null, glAccountId: DEFAULT, projectId: null, cc1Id: null, cc2Id: null, buId: null, amount: 800, isExcess: true },
    ]);
  });

  it('records the leg by identity (glAccountId), not where it posts now', () => {
    const { lines, allocations } = allocateCreditNote([
      { glAccountId: COMMERCIALS, postAccountId: DEFAULT, projectId: P1, cc1Id: null, cc2Id: CC, buId: null, net: 600, journalLineId: 'l1' },
    ], 100, 'CN-1', DEFAULT);
    expect(debits(lines)).toEqual([[DEFAULT, P1, 100]]);
    expect(allocations).toEqual([
      { journalLineId: 'l1', glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: CC, buId: null, amount: 100, isExcess: false },
    ]);
  });

  it('debits a leg where it posts NOW (postAccountId) while counting it by identity', () => {
    const out = prorateRevenueLegs([
      { glAccountId: COMMERCIALS, postAccountId: DEFAULT, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 600 },
      { glAccountId: POST, projectId: null, cc1Id: null, cc2Id: null, buId: null, net: 400 },
    ], 1000, 'CN-1', DEFAULT, [500]);
    expect(debits(out)).toEqual([[DEFAULT, P1, 300], [POST, null, 200], [DEFAULT, null, 500]]);
  });

  it('an over-credit on an UNCODED invoice posts the one default_revenue line master did', () => {
    expect(prorateRevenueLegs([{ glAccountId: DEFAULT, projectId: null, cc1Id: null, cc2Id: null, buId: null, net: 1000 }], 1500, 'CN-1', DEFAULT))
      .toEqual([{ glAccountId: DEFAULT, debit: 1500, credit: 0, description: 'Credit note CN-1', projectId: undefined, cc2Id: undefined }]);
  });

  it('clamps the rounding cent that would push a leg past what it carries, and posts it untagged', () => {
    // Found by search: unclamped, the second leg (0.29 left) would take 0.30.
    const carries = [17, 29, 29, 18, 20, 29, 28, 18, 26, 14];
    const out = prorate(carries.map((c, i) => ({ glAccountId: `acct-${i}`, projectId: null, cc1Id: null, cc2Id: null, buId: null, net: c / 100 })), 2.21);
    const taken = carries.map((_c, i) => Math.round((out.find((l) => l.glAccountId === `acct-${i}`)?.debit ?? 0) * 100));
    taken.forEach((t, i) => expect(t).toBeLessThanOrEqual(carries[i]!));
    expect(Math.round(out.reduce((s, l) => s + l.debit, 0) * 100)).toBe(221);
    expect(out.find((l) => l.glAccountId === DEFAULT)?.debit).toBe(0.01);
  });

  it('a leg the invoice posted as a debit (a discount) is credited back pro rata', () => {
    const out = prorate([
      { glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 1000 },
      { glAccountId: POST, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: -100 },
    ], 450);
    expect(out.map((l) => [l.debit, l.credit])).toEqual([[500, 0], [0, 50]]);
    expect(validateJournalEntry([...out, { glAccountId: 'acct-ar', debit: 0, credit: 450 }]).valid).toBe(true);
  });

  it('an over-credit never credits a discount leg back past what the invoice debited there', () => {
    const out = prorate([
      { glAccountId: COMMERCIALS, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: 1000 },
      { glAccountId: POST, projectId: P1, cc1Id: null, cc2Id: null, buId: null, net: -100 },
    ], 1500);
    expect(debits(out)).toEqual([[COMMERCIALS, P1, 1000], [POST, P1, -100], [DEFAULT, null, 600]]);
  });

  it('legs netting to nothing, or none at all, put the whole note on default_revenue', () => {
    expect(debits(prorate([], 100))).toEqual([[DEFAULT, null, 100]]);
    expect(debits(prorate([{ glAccountId: POST, projectId: null, cc1Id: null, cc2Id: null, buId: null, net: -5 }], 100))).toEqual([[DEFAULT, null, 100]]);
  });
});
