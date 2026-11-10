/**
 * classifyEmployment: PAYE-GEN-01-G21 (2027) Rev 1 p. 27-28, row by row. The summary table's rows, in the guide's order:
 *  1. standard (22+ h a week), over the annual threshold      -> tables
 *  2. standard (22+ h a week), within the annual threshold    -> no tax (the tables give nil)
 *  3. non-standard, 5+ h a day, under R394 a day              -> no tax (deemed standard, p. 28: the same band, tables give nil)
 *  4. non-standard, 5+ h a day, over R394 a day               -> 25%
 *  5. non-standard, under 5 h a day, under R394 a day         -> 25%
 * and the case the table does not print (under 5 h a day, R394 or more), which the residual definition catches (25%).
 */
import { describe, expect, it } from 'vitest';
import { classifyEmployment, employedShareOfMonth, type WorkTerms } from '@/modules/accounting/services/payroll/employmentTerms';

const terms = (t: Partial<WorkTerms>): WorkTerms => ({
  taxStatus: 'employee', payBasis: 'daily', hoursPerWeek: null, hoursPerDay: null, hourlyRate: null, dailyRate: null, ...t,
});
const kind = (t: Partial<WorkTerms>, year = 2027) => classifyEmployment(terms(t), year).kind;

describe('G21 p. 27-28 summary table, row by row', () => {
  it('rows 1 and 2: at least 22 hours a week is standard, whatever the day looks like', () => {
    expect(kind({ hoursPerWeek: 40 })).toBe('standard');
    expect(kind({ hoursPerWeek: 22, hoursPerDay: 3, dailyRate: 900 })).toBe('standard');
  });

  it('row 3: 5+ hours a day under R394, under 22 hours a week: deemed standard (tables)', () => {
    expect(kind({ hoursPerWeek: 21, hoursPerDay: 5, dailyRate: 390 })).toBe('deemed_standard');
  });

  it('row 4: 5+ hours a day over R394: non-standard, 25%', () => {
    expect(kind({ hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 500 })).toBe('non_standard_flat');
  });

  it('row 5: under 5 hours a day under R394: non-standard, 25%', () => {
    expect(kind({ hoursPerWeek: 14, hoursPerDay: 4, dailyRate: 300 })).toBe('non_standard_flat');
  });

  it('under 5 hours a day at R394 or more (no table row): the residual definition, 25%', () => {
    expect(kind({ hoursPerWeek: 14, hoursPerDay: 4, dailyRate: 450 })).toBe('non_standard_flat');
  });

  it('the oracle ts-* cases: 20 h with 5 h days at R390 is deemed standard, not flat', () => {
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 390 })).toBe('deemed_standard');
  });
});

describe('boundaries', () => {
  it('22 hours a week is standard; one minute under (21.98) with a 6 h, R500 day is not', () => {
    expect(kind({ hoursPerWeek: 22, hoursPerDay: 6, dailyRate: 500 })).toBe('standard');
    expect(kind({ hoursPerWeek: 21.98, hoursPerDay: 6, dailyRate: 500 })).toBe('non_standard_flat');
  });

  it('the daily threshold is "less than R394": R393.99 is deemed standard, R394.00 is flat (2027)', () => {
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 393.99 })).toBe('deemed_standard');
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 394 })).toBe('non_standard_flat');
  });

  it('2026 is strict at the cent too: R382.99 is deemed standard, R383.00 is flat (G20 p. 28)', () => {
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 382.99 }, 2026)).toBe('deemed_standard');
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 383 }, 2026)).toBe('non_standard_flat');
  });

  it('the 2026 threshold is R383 (G20 p. 28): R383.00 is flat there, deemed standard in 2027', () => {
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 383 }, 2026)).toBe('non_standard_flat');
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 383 }, 2027)).toBe('deemed_standard');
  });

  it('5 hours a day is the line: 4.99 is non-standard, 5 is deemed standard (under R394)', () => {
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 4.99, dailyRate: 300 })).toBe('non_standard_flat');
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 300 })).toBe('deemed_standard');
  });

  it('an hourly rate over the day gives the day pay: R80 x 5 h = R400 is flat, R78 x 5 h = R390 is deemed standard', () => {
    expect(kind({ payBasis: 'hourly', hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 80 })).toBe('non_standard_flat');
    expect(kind({ payBasis: 'hourly', hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 78 })).toBe('deemed_standard');
  });
});

describe('missing terms are never silent', () => {
  it('a monthly employee with no hours is standard, flagged hoursNotRecorded with the spec wording', () => {
    const c = classifyEmployment(terms({ payBasis: 'monthly' }), 2027);
    expect(c.kind).toBe('standard');
    expect(c.hoursNotRecorded).toBe(true);
    expect(c.reason).toBe('Hours not recorded; classified as standard employment');
  });

  it.each(['hourly', 'daily'] as const)('a %s employee with no hours is undetermined', (payBasis) => {
    expect(kind({ payBasis })).toBe('undetermined');
  });

  it('under 22 hours with neither hours a day nor a day rate cannot be told', () => {
    expect(kind({ hoursPerWeek: 20 })).toBe('undetermined');
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5 })).toBe('undetermined');
    expect(kind({ hoursPerWeek: 20, dailyRate: 300 })).toBe('undetermined');
  });

  it('a year with a null daily threshold (2025: G19 not fetched) never classifies daily-rated staff', () => {
    for (const t of [
      { hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 300 }, { hoursPerWeek: 20, hoursPerDay: 4, dailyRate: 300 },
      { hoursPerWeek: 20, hoursPerDay: 6, dailyRate: 900 }, { hoursPerWeek: 20, hoursPerDay: 4 },
      { payBasis: 'monthly' as const, hoursPerWeek: 20, hoursPerDay: 4, dailyRate: 300 },
    ]) expect(kind(t, 2025)).toBe('undetermined');
    // hours of 22 or more need no threshold; 2026 and 2027 have one.
    expect(kind({ hoursPerWeek: 22 }, 2025)).toBe('standard');
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 4, dailyRate: 300 }, 2026)).toBe('non_standard_flat');
  });

  it('a director and a contractor are not classified by hours', () => {
    expect(kind({ taxStatus: 'director', hoursPerWeek: 5, hoursPerDay: 1, dailyRate: 900 })).toBe('standard');
    expect(kind({ taxStatus: 'independent_contractor', hoursPerWeek: 5 })).toBe('standard');
  });
});

describe('day pay follows what the line pays (G21 p. 28 "earns ... for that day")', () => {
  // R70 an hour, 20 hours a week in 5-hour days: R350 a day by the rate (deemed standard), but R15 000 a month over 4 days a week.
  const R70 = terms({ payBasis: 'hourly', hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 70 });

  it('the recorded R350 day says deemed standard without earnings; R15 000 a month says flat, with a note', () => {
    expect(classifyEmployment(R70, 2027).kind).toBe('deemed_standard');
    const c = classifyEmployment(R70, 2027, { earnings: 15_000 });
    expect(c.kind).toBe('non_standard_flat');
    expect(c.dayPayNote).toMatch(/R\s350\.00/);
    expect(c.dayPayNote).toContain('basic pay and overtime');
  });

  it('overtime that lifts a day over R394 makes it flat: R78 an hour (R390) with R7 800 paid over 17.3 days', () => {
    const t = terms({ payBasis: 'hourly', hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 78 });
    expect(classifyEmployment(t, 2027, { earnings: 6_760 }).kind).toBe('deemed_standard'); // exactly the scheduled days at the rate
    expect(classifyEmployment(t, 2027, { earnings: 7_800 }).kind).toBe('non_standard_flat');
    expect(classifyEmployment(t, 2027, { earnings: 7_800 }).dayPayNote).toBeDefined();
  });

  it('earnings within 3% of the rate leave the recorded rate to decide, exactly (R393.99 stays deemed standard)', () => {
    const t = terms({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 393.99 });
    const c = classifyEmployment(t, 2027, { earnings: 6_800 }); // 6 800 / 17.33 = R392.3, within 3%
    expect([c.kind, c.dayPayNote]).toEqual(['deemed_standard', undefined]);
  });

  it('with no recorded rate the earned day pay stands in (and with no schedule it cannot)', () => {
    expect(classifyEmployment(terms({ hoursPerWeek: 20, hoursPerDay: 5 }), 2027, { earnings: 15_000 }).kind).toBe('non_standard_flat');
    expect(classifyEmployment(terms({ hoursPerWeek: 20 }), 2027, { earnings: 15_000 }).kind).toBe('undetermined');
  });
});

describe('earnings may only raise the day pay (a short month never lowers the withholding)', () => {
  // 12 h a week in 6 h days = 2 days a week = 8.67 scheduled days a month; R500 a day recorded.
  const R500 = terms({ hoursPerWeek: 12, hoursPerDay: 6, dailyRate: 500 });

  it('a starter on the 16th, paid half the month: earned day pay is not below the rate, class stays flat, no note', () => {
    const half = employedShareOfMonth({ year: 2026, month: 3 }, new Date(2026, 2, 16));
    expect(half).toBeCloseTo(12 / 22, 5); // working days: 16th (a Monday) to the 31st is 12 of March's 22
    const c = classifyEmployment(R500, 2027, { earnings: 500 * 8.6667 * half, employedShare: half });
    expect([c.kind, c.dayPayNote]).toEqual(['non_standard_flat', undefined]);
  });

  it('10 of 17 days unpaid (earnings far under the schedule): the R500 rate still decides, flat', () => {
    expect(classifyEmployment(R500, 2027, { earnings: 500 * 3 }).kind).toBe('non_standard_flat');
  });

  it('hourly R100, scheduled 10 h a week in 5 h days (R500 a day), paid for 40 hours (R4 000): flat', () => {
    const t = terms({ payBasis: 'hourly', hoursPerWeek: 10, hoursPerDay: 5, hourlyRate: 100 });
    expect(classifyEmployment(t, 2027, { earnings: 4_000 }).kind).toBe('non_standard_flat');
  });

  it('a short month cannot lower a deemed-standard rate into... nothing: R390 recorded, earnings far under, stays deemed standard', () => {
    const t = terms({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 390 });
    expect(classifyEmployment(t, 2027, { earnings: 1_000 }).kind).toBe('deemed_standard');
  });

  it('no recorded rate, a part month: the scheduled days shrink with the days employed (R4 000 over half a month is R447 a day: flat; unscaled it would be R231)', () => {
    const t = terms({ hoursPerWeek: 20, hoursPerDay: 5 });
    const half = employedShareOfMonth({ year: 2026, month: 3 }, new Date(2026, 2, 16));
    expect(classifyEmployment(t, 2027, { earnings: 4_000, employedShare: half }).kind).toBe('non_standard_flat');
    expect(classifyEmployment(t, 2027, { earnings: 4_000 }).kind).toBe('deemed_standard');
  });

  it('the tolerance governs the warning only: recorded R390 and earned about R401 (2.8% over) is flat, with no note', () => {
    const t = terms({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 390 });
    const c = classifyEmployment(t, 2027, { earnings: 401 * (20 / 5) * (52 / 12) });
    expect([c.kind, c.dayPayNote]).toEqual(['non_standard_flat', undefined]);
  });

  it('the note says earnings only raise the day pay', () => {
    const c = classifyEmployment(terms({ payBasis: 'hourly', hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 70 }), 2027, { earnings: 15_000 });
    expect(c.dayPayNote).toContain('can only raise');
  });
});

describe('employedShareOfMonth: working days (Monday to Friday)', () => {
  const march = { year: 2026, month: 3 }; // 22 working days; the 1st is a Sunday, the 31st a Tuesday
  it('a full month is 1', () => expect(employedShareOfMonth(march, new Date(2020, 0, 1))).toBe(1));
  it('a leaver on the 15th (a Sunday): 10 of 22 working days', () => {
    expect(employedShareOfMonth(march, new Date(2020, 0, 1), new Date(2026, 2, 15))).toBeCloseTo(10 / 22, 5);
  });
  it('the 31st-day starter is 1 of 22 working days, not 1 of 31', () => {
    expect(employedShareOfMonth(march, new Date(2026, 2, 31))).toBeCloseTo(1 / 22, 5);
  });
  it('a starter on a Saturday (28 February would be) or Sunday loses no working day: a Sunday 1 March start is the whole month', () => {
    expect(employedShareOfMonth(march, new Date(2026, 2, 1))).toBe(1);
  });
  it('a start and leave inside one month count their working days', () => {
    expect(employedShareOfMonth(march, new Date(2026, 2, 10), new Date(2026, 2, 19))).toBeCloseTo(8 / 22, 5);
  });
  it('a start on the month\'s last weekend (Saturday 31 October 2026) is employed on no working day: one working day, not 0', () => {
    const oct = { year: 2026, month: 10 }; // 22 working days, the 31st is a Saturday
    expect(employedShareOfMonth(oct, new Date(2026, 9, 31))).toBeCloseTo(1 / 22, 5);
    expect(employedShareOfMonth(oct, new Date(2026, 9, 30))).toBeCloseTo(1 / 22, 5); // the Friday: one working day too
    // classified as employed with no rate: R500 over one working day is a flat-rate day, not "full month" R29
    const c = classifyEmployment(terms({ hoursPerWeek: 20, hoursPerDay: 5 }), 2027, { earnings: 500, employedShare: employedShareOfMonth(oct, new Date(2026, 9, 31)) });
    expect(c.kind).toBe('non_standard_flat');
  });
  it('LIMIT: public holidays are not excluded (no calendar in the repo, none hardcoded): 14 December 2026 counts 16 December as a working day', () => {
    expect(employedShareOfMonth({ year: 2026, month: 12 }, new Date(2026, 11, 14))).toBeCloseTo(14 / 23, 5);
  });
  it('not employed in the month: 0 (an end before it, a start after it)', () => {
    expect(employedShareOfMonth(march, new Date(2020, 0, 1), new Date(2026, 1, 20))).toBe(0);
    expect(employedShareOfMonth(march, new Date(2026, 3, 1))).toBe(0);
  });
});

describe('a line for a person not employed in the period (L1) and a line with no rate (M5)', () => {
  const sched = { hoursPerWeek: 20, hoursPerDay: 5 };
  it('a leaver paid R10 000 back pay after leaving, rate R300 recorded: the rate decides alone, deemed standard', () => {
    const c = classifyEmployment(terms({ ...sched, dailyRate: 300 }), 2027, { earnings: 10_000, employedShare: 0 });
    expect([c.kind, c.dayPayNote, c.rateNotRecorded]).toEqual(['deemed_standard', undefined, undefined]);
  });
  it('the same leaver with no rate: earnings over the full month stand in (R577 a day: flat), with the no-rate flag', () => {
    const c = classifyEmployment(terms(sched), 2027, { earnings: 10_000, employedShare: 0 });
    expect([c.kind, c.rateNotRecorded]).toEqual(['non_standard_flat', true]);
  });
  it('a line classified from earnings alone says so; a line with a recorded rate does not', () => {
    expect(classifyEmployment(terms(sched), 2027, { earnings: 4_000 }).rateNotRecorded).toBe(true);
    expect(classifyEmployment(terms({ ...sched, dailyRate: 300 }), 2027, { earnings: 4_000 }).rateNotRecorded).toBeUndefined();
  });
});
