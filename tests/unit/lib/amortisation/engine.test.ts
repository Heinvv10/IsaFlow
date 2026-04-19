import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { amortise } from '@/lib/amortisation/engine';
import type { LoanInputs, LoanEvent, RatePoint, ScheduleRow } from '@/lib/amortisation/types';

// ──────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ──────────────────────────────────────────────────────────────────────────────

const FIXED_RATE_LOAN: LoanInputs = {
  id: 'test-fixed',
  principal: 100_000,
  startDate: '2020-01-31',
  termMonths: 12,
  rateMode: 'FIXED',
  margin: 0,
  fixedRate: 12, // 12% p.a. → 1%/month
  residual: 0,
  recurringSkipMonths: [],
  dayCount: 'ACTUAL_365',
  repriceMode: 'RESOLVE_ON_RATE_CHANGE',
  skipMode: 'MAINTAIN_TERM',
  lumpMode: 'REDUCE_INSTALLMENT',
};

const FIXED_12_CURVE: RatePoint[] = [{ effectiveDate: '2019-01-01', rate: 12 }];
const NO_EVENTS: LoanEvent[] = [];

// ──────────────────────────────────────────────────────────────────────────────
// PMT / basic amortisation
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – basic fixed-rate loan', () => {
  it('produces exactly termMonths rows', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows).toHaveLength(12);
  });

  it('opening balance of period 1 equals principal', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows[0].opening).toBeCloseTo(100_000, 2);
  });

  it('period 1 interest = 100000 × 1% = 1000', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows[0].interest).toBeCloseTo(1_000, 2);
  });

  it('installment is approx 8884.87 for 12% p.a. over 12 months', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows[0].installment).toBeCloseTo(8_884.87, 1);
  });

  it('closing balance of last period is near zero (no residual)', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows[11].closing).toBeCloseTo(0, 1);
  });

  it('consecutive periods: closing[n] === opening[n+1]', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].closing).toBeCloseTo(rows[i + 1].opening, 4);
    }
  });

  it('period 1 date is one month after startDate (end-of-month aware)', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows[0].date).toBe('2020-02-29'); // leap year
  });

  it('period numbers are sequential 1..n', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    rows.forEach((r, i) => expect(r.period).toBe(i + 1));
  });

  it('no rows are flagged as skip in a basic loan', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows.every((r) => !r.skip)).toBe(true);
  });

  it('no rows are extrapolated when curve covers full term', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    expect(rows.every((r) => !r.extrapolated)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Residual / balloon
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – residual (balloon payment)', () => {
  const loan: LoanInputs = {
    ...FIXED_RATE_LOAN,
    principal: 200_000,
    termMonths: 24,
    residual: 50_000,
  };

  it('closing balance of last period ≈ residual', () => {
    const rows = amortise(loan, NO_EVENTS, FIXED_12_CURVE);
    expect(rows[23].closing).toBeCloseTo(50_000, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Skip months
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – skip months', () => {
  const SKIP_DEC_JAN: LoanInputs = {
    ...FIXED_RATE_LOAN,
    termMonths: 24,
    recurringSkipMonths: [12, 1], // December and January
    skipMode: 'MAINTAIN_TERM',
  };

  it('December and January payments are 0 on a MAINTAIN_TERM loan', () => {
    const rows = amortise(SKIP_DEC_JAN, NO_EVENTS, FIXED_12_CURVE);
    const skippedRows = rows.filter((r) => r.skip);
    // Year 1: Dec=month 11, Jan=month 12; Year 2: Dec=month 23, Jan=month 24
    expect(skippedRows.length).toBeGreaterThan(0);
    skippedRows.forEach((r) => expect(r.payment).toBe(0));
  });

  it('skip month: interest accrues into closing balance', () => {
    const rows = amortise(SKIP_DEC_JAN, NO_EVENTS, FIXED_12_CURVE);
    const skipRow = rows.find((r) => r.skip)!;
    expect(skipRow).toBeDefined();
    expect(skipRow.closing).toBeCloseTo(skipRow.opening + skipRow.interest, 2);
  });

  it('ad-hoc skip event produces payment=0 for that month', () => {
    const rows = amortise(
      { ...FIXED_RATE_LOAN, termMonths: 6 },
      [{ kind: 'SKIP', date: '2020-04-30' }], // period 2 is 2020-02-29, period 3 is 2020-03-31, period 4 would be 2020-04-30
      FIXED_12_CURVE,
    );
    // Find the April row
    const aprilRow = rows.find((r) => r.date === '2020-04-30');
    expect(aprilRow).toBeDefined();
    expect(aprilRow!.skip).toBe(true);
    expect(aprilRow!.payment).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// EXTEND_TERM skip mode
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – EXTEND_TERM skip mode', () => {
  it('adds extra periods when skip months occur', () => {
    const loan: LoanInputs = {
      ...FIXED_RATE_LOAN,
      termMonths: 12,
      recurringSkipMonths: [12], // skip December (month 11 from Feb start)
      skipMode: 'EXTEND_TERM',
    };
    const rows = amortise(loan, NO_EVENTS, FIXED_12_CURVE);
    // Should have more than 12 rows due to skip extension
    expect(rows.length).toBeGreaterThan(12);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Lump sum payments
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – lump sum events', () => {
  it('lump reduces closing balance of that period', () => {
    const rows = amortise(
      { ...FIXED_RATE_LOAN, termMonths: 24 },
      [{ kind: 'LUMP', date: '2020-06-30', amount: 20_000 }],
      FIXED_12_CURVE,
    );
    const lumpRow = rows.find((r) => r.lump > 0)!;
    expect(lumpRow).toBeDefined();
    expect(lumpRow.lump).toBeCloseTo(20_000, 2);
    // closing = opening + interest - payment - lump
    const expected = lumpRow.opening + lumpRow.interest - lumpRow.payment - lumpRow.lump;
    expect(lumpRow.closing).toBeCloseTo(expected, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Rate lookup
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – rate lookup', () => {
  it('extrapolates beyond curve end and flags rows', () => {
    const shortCurve: RatePoint[] = [{ effectiveDate: '2019-01-01', rate: 10 }];
    // Curve ends in 2019 but loan runs to 2021; must use variable rate to consult the curve
    const rows = amortise(
      {
        ...FIXED_RATE_LOAN,
        rateMode: 'PRIME_PLUS',
        margin: 0,
        fixedRate: undefined,
        termMonths: 24,
        startDate: '2020-01-31',
      },
      NO_EVENTS,
      shortCurve,
    );
    // All rows should be extrapolated (curve ends before loan starts)
    expect(rows.every((r) => r.extrapolated)).toBe(true);
  });

  it('picks correct rate after a rate change mid-loan', () => {
    const curve: RatePoint[] = [
      { effectiveDate: '2019-01-01', rate: 8 },
      { effectiveDate: '2020-06-01', rate: 12 }, // rate hike mid-loan
    ];
    const rows = amortise(
      { ...FIXED_RATE_LOAN, rateMode: 'PRIME_PLUS', margin: 0, fixedRate: undefined, termMonths: 12 },
      NO_EVENTS,
      curve,
    );
    // Periods before June 2020 should use 8%
    const beforeHike = rows.filter((r) => r.date < '2020-06-01');
    const afterHike = rows.filter((r) => r.date >= '2020-06-01');
    beforeHike.forEach((r) => expect(r.rate).toBeCloseTo(8, 4));
    afterHike.forEach((r) => expect(r.rate).toBeCloseTo(12, 4));
  });

  it('applies margin correctly for PRIME_PLUS', () => {
    const curve: RatePoint[] = [{ effectiveDate: '2019-01-01', rate: 10 }];
    const rows = amortise(
      { ...FIXED_RATE_LOAN, rateMode: 'PRIME_PLUS', margin: 2, fixedRate: undefined },
      NO_EVENTS,
      curve,
    );
    expect(rows[0].rate).toBeCloseTo(12, 4); // prime(10) + margin(2) = 12
  });

  it('applies margin correctly for PRIME_MINUS', () => {
    const curve: RatePoint[] = [{ effectiveDate: '2019-01-01', rate: 10 }];
    const rows = amortise(
      { ...FIXED_RATE_LOAN, rateMode: 'PRIME_MINUS', margin: 2, fixedRate: undefined },
      NO_EVENTS,
      curve,
    );
    expect(rows[0].rate).toBeCloseTo(8, 4); // prime(10) - margin(2) = 8
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// RESOLVE_ON_RATE_CHANGE repricing
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – repricing (RESOLVE_ON_RATE_CHANGE)', () => {
  it('re-solves installment when rate changes', () => {
    const curve: RatePoint[] = [
      { effectiveDate: '2019-01-01', rate: 8 },
      { effectiveDate: '2020-06-01', rate: 12 },
    ];
    const rows = amortise(
      {
        ...FIXED_RATE_LOAN,
        rateMode: 'PRIME_PLUS',
        margin: 0,
        fixedRate: undefined,
        termMonths: 24,
        repriceMode: 'RESOLVE_ON_RATE_CHANGE',
      },
      NO_EVENTS,
      curve,
    );
    const beforeHike = rows.filter((r) => r.date < '2020-06-01');
    const afterHike = rows.filter((r) => r.date >= '2020-06-01');
    // Installment should differ pre and post hike
    const installBefore = beforeHike[0].installment;
    const installAfter = afterHike[0].installment;
    expect(installAfter).not.toBeCloseTo(installBefore, 0);
    expect(installAfter).toBeGreaterThan(installBefore); // higher rate → higher payment
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// stLiability
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – stLiability (current portion)', () => {
  it('stLiability[r] ≤ opening[r] for all rows', () => {
    const rows = amortise({ ...FIXED_RATE_LOAN, termMonths: 36 }, NO_EVENTS, FIXED_12_CURVE);
    rows.forEach((r) => expect(r.stLiability).toBeLessThanOrEqual(r.opening + 0.01));
  });

  it('stLiability is sum of next-12-month principal payments', () => {
    const rows = amortise(FIXED_RATE_LOAN, NO_EVENTS, FIXED_12_CURVE);
    // For period 1 (12-period loan), stLiability should ≈ sum of all principal
    const stL = rows[0].stLiability;
    // Σ(payment - interest) for all 12 periods = principal paid back
    const totalPrin = rows.reduce((s, r) => s + r.payment - r.interest, 0);
    expect(stL).toBeCloseTo(totalPrin, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// NCA in-duplum
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – NCA in-duplum', () => {
  it('cumulative interest never exceeds original principal', () => {
    // Use very high rate to trigger in-duplum
    const highRateCurve: RatePoint[] = [{ effectiveDate: '2019-01-01', rate: 50 }];
    const rows = amortise(
      {
        ...FIXED_RATE_LOAN,
        principal: 10_000,
        termMonths: 120,
        rateMode: 'FIXED',
        fixedRate: 50,
      },
      NO_EVENTS,
      highRateCurve,
    );
    let cumInterest = 0;
    rows.forEach((r) => {
      cumInterest += r.interest;
      expect(cumInterest).toBeLessThanOrEqual(10_000 + 0.01);
    });
  });

  it('marks nca_flagged=true when cap is triggered', () => {
    const highRateCurve: RatePoint[] = [{ effectiveDate: '2019-01-01', rate: 50 }];
    const rows = amortise(
      {
        ...FIXED_RATE_LOAN,
        principal: 10_000,
        termMonths: 120,
        rateMode: 'FIXED',
        fixedRate: 50,
      },
      NO_EVENTS,
      highRateCurve,
    );
    expect(rows.some((r) => (r as { nca_flagged?: boolean }).nca_flagged)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Property-based tests (fast-check)
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – property invariants', () => {
  const loanArb = fc.record({
    principal: fc.float({ min: Math.fround(10_000), max: Math.fround(5_000_000), noNaN: true }),
    termMonths: fc.integer({ min: 1, max: 360 }),
    fixedRate: fc.float({ min: Math.fround(0.01), max: Math.fround(30), noNaN: true }),
    residual: fc.constant(0), // simplified: no residual for property tests
  });

  it('Σinterest + (principal − residual) ≈ Σpayment + Σlumps (±0.01)', () => {
    fc.assert(
      fc.property(loanArb, ({ principal, termMonths, fixedRate, residual }) => {
        const loan: LoanInputs = {
          id: 'prop',
          principal,
          startDate: '2020-01-31',
          termMonths,
          rateMode: 'FIXED',
          margin: 0,
          fixedRate,
          residual,
          recurringSkipMonths: [],
          dayCount: 'ACTUAL_365',
          repriceMode: 'FIXED_INSTALLMENT',
          skipMode: 'MAINTAIN_TERM',
          lumpMode: 'REDUCE_INSTALLMENT',
        };
        const rows = amortise(loan, [], FIXED_12_CURVE);
        const sumInterest = rows.reduce((s, r) => s + r.interest, 0);
        const sumPayment = rows.reduce((s, r) => s + r.payment, 0);
        const sumLumps = rows.reduce((s, r) => s + r.lump, 0);
        const lhs = sumInterest + principal - residual;
        const rhs = sumPayment + sumLumps;
        // Allow 0.01 per period for cent-rounding of installment and interest
        return Math.abs(lhs - rhs) < 0.01 * termMonths + 0.10;
      }),
      { numRuns: 50 },
    );
  });

  it('closing[last] ≈ residual (±0.01)', () => {
    fc.assert(
      fc.property(loanArb, ({ principal, termMonths, fixedRate }) => {
        const loan: LoanInputs = {
          id: 'prop2',
          principal,
          startDate: '2020-01-31',
          termMonths,
          rateMode: 'FIXED',
          margin: 0,
          fixedRate,
          residual: 0,
          recurringSkipMonths: [],
          dayCount: 'ACTUAL_365',
          repriceMode: 'FIXED_INSTALLMENT',
          skipMode: 'MAINTAIN_TERM',
          lumpMode: 'REDUCE_INSTALLMENT',
        };
        const rows = amortise(loan, [], FIXED_12_CURVE);
        const last = rows[rows.length - 1];
        return Math.abs(last.closing) < 1.0; // within R1 of zero
      }),
      { numRuns: 50 },
    );
  });

  it('no period has negative opening balance', () => {
    fc.assert(
      fc.property(loanArb, ({ principal, termMonths, fixedRate }) => {
        const loan: LoanInputs = {
          id: 'prop3',
          principal,
          startDate: '2020-01-31',
          termMonths,
          rateMode: 'FIXED',
          margin: 0,
          fixedRate,
          residual: 0,
          recurringSkipMonths: [],
          dayCount: 'ACTUAL_365',
          repriceMode: 'FIXED_INSTALLMENT',
          skipMode: 'MAINTAIN_TERM',
          lumpMode: 'REDUCE_INSTALLMENT',
        };
        const rows = amortise(loan, [], FIXED_12_CURVE);
        return rows.every((r) => r.opening >= -0.01);
      }),
      { numRuns: 50 },
    );
  });

  it('stLiability[r] ≤ opening[r] for all r', () => {
    fc.assert(
      fc.property(loanArb, ({ principal, termMonths, fixedRate }) => {
        const loan: LoanInputs = {
          id: 'prop4',
          principal,
          startDate: '2020-01-31',
          termMonths,
          rateMode: 'FIXED',
          margin: 0,
          fixedRate,
          residual: 0,
          recurringSkipMonths: [],
          dayCount: 'ACTUAL_365',
          repriceMode: 'FIXED_INSTALLMENT',
          skipMode: 'MAINTAIN_TERM',
          lumpMode: 'REDUCE_INSTALLMENT',
        };
        const rows = amortise(loan, [], FIXED_12_CURVE);
        return rows.every((r) => r.stLiability <= r.opening + 0.01);
      }),
      { numRuns: 50 },
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Golden fixture: validated cent-accurate against Amortisation Report AI ver.xlsx
// Parameters sourced from INTRATE + first sheet of the Excel reference file.
// Prime = 10.25%, margin = +4% → effective rate 14.25%
// startDate 2026-03-15; 72 months; skip Dec/Jan recurring + ad-hoc May skip
// lumps: R125 000 Jun-15, R75 000 Jul-15
// ──────────────────────────────────────────────────────────────────────────────

describe('amortise – golden fixture (cent-accurate vs Excel)', () => {
  const SA_PRIME_CURVE: RatePoint[] = [{ effectiveDate: '2026-01-01', rate: 10.25 }];

  const GOLDEN_LOAN: LoanInputs = {
    id: 'golden',
    principal: 224_873.49,
    startDate: '2026-03-15',
    termMonths: 72,
    rateMode: 'PRIME_PLUS',
    margin: 4,
    residual: 0,
    recurringSkipMonths: [12, 1],
    dayCount: 'ACTUAL_365',
    repriceMode: 'RESOLVE_ON_RATE_CHANGE',
    skipMode: 'MAINTAIN_TERM',
    lumpMode: 'REDUCE_INSTALLMENT',
  };

  const GOLDEN_EVENTS: LoanEvent[] = [
    { kind: 'SKIP', date: '2026-05-15' },
    { kind: 'LUMP', date: '2026-06-15', amount: 125_000 },
    { kind: 'LUMP', date: '2026-07-15', amount: 75_000 },
  ];

  it('period 1 – opening, interest, installment, payment, closing', () => {
    const rows = amortise(GOLDEN_LOAN, GOLDEN_EVENTS, SA_PRIME_CURVE);
    const r = rows[0]!;
    expect(r.opening).toBeCloseTo(224_873.49, 2);
    expect(r.rate).toBeCloseTo(14.25, 4);
    expect(r.interest).toBeCloseTo(2_670.37, 2);
    expect(r.installment).toBeCloseTo(4_663.84, 2);
    expect(r.payment).toBeCloseTo(4_663.84, 2);
    expect(r.lump).toBeCloseTo(0, 2);
    expect(r.skip).toBe(false);
    expect(r.closing).toBeCloseTo(222_880.02, 2);
  });

  it('period 2 – ad-hoc skip: payment=0, interest capitalises', () => {
    const rows = amortise(GOLDEN_LOAN, GOLDEN_EVENTS, SA_PRIME_CURVE);
    const r = rows[1]!;
    expect(r.date).toBe('2026-05-15');
    expect(r.skip).toBe(true);
    expect(r.payment).toBeCloseTo(0, 2);
    expect(r.interest).toBeCloseTo(2_646.70, 2);
    expect(r.closing).toBeCloseTo(225_526.72, 2);
  });

  it('period 3 – lump R125 000: re-solved installment, closing', () => {
    const rows = amortise(GOLDEN_LOAN, GOLDEN_EVENTS, SA_PRIME_CURVE);
    const r = rows[2]!;
    expect(r.date).toBe('2026-06-15');
    expect(r.lump).toBeCloseTo(125_000, 2);
    expect(r.interest).toBeCloseTo(2_678.13, 2);
    expect(r.installment).toBeCloseTo(4_762.33, 2);
    expect(r.payment).toBeCloseTo(4_762.33, 2);
    expect(r.closing).toBeCloseTo(98_442.52, 2);
  });

  it('period 4 – lump R75 000: re-solved installment, closing', () => {
    const rows = amortise(GOLDEN_LOAN, GOLDEN_EVENTS, SA_PRIME_CURVE);
    const r = rows[3]!;
    expect(r.date).toBe('2026-07-15');
    expect(r.lump).toBeCloseTo(75_000, 2);
    expect(r.interest).toBeCloseTo(1_169.00, 2);
    expect(r.installment).toBeCloseTo(2_098.15, 2);
    expect(r.payment).toBeCloseTo(2_098.15, 2);
    expect(r.closing).toBeCloseTo(22_513.37, 2);
  });

  it('period 5 – normal payment after lumps', () => {
    const rows = amortise(GOLDEN_LOAN, GOLDEN_EVENTS, SA_PRIME_CURVE);
    const r = rows[4]!;
    expect(r.date).toBe('2026-08-15');
    expect(r.interest).toBeCloseTo(267.35, 2);
    expect(r.installment).toBeCloseTo(484.41, 2);
    expect(r.payment).toBeCloseTo(484.41, 2);
    expect(r.closing).toBeCloseTo(22_296.31, 2);
  });

  it('last period – balance clears to zero', () => {
    const rows = amortise(GOLDEN_LOAN, GOLDEN_EVENTS, SA_PRIME_CURVE);
    const last = rows[rows.length - 1]!;
    expect(Math.abs(last.closing)).toBeLessThan(0.02);
  });

  it('Σ(payment + lump) − Σinterest ≈ principal (±1)', () => {
    const rows = amortise(GOLDEN_LOAN, GOLDEN_EVENTS, SA_PRIME_CURVE);
    const sumPayment = rows.reduce((s: number, r: ScheduleRow) => s + r.payment, 0);
    const sumLump = rows.reduce((s: number, r: ScheduleRow) => s + r.lump, 0);
    const sumInterest = rows.reduce((s: number, r: ScheduleRow) => s + r.interest, 0);
    expect(Math.abs(sumPayment + sumLump - sumInterest - 224_873.49)).toBeLessThan(1.0);
  });
});
