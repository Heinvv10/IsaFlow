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
import { classifyEmployment, type WorkTerms } from '@/modules/accounting/services/payroll/employmentTerms';

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

  it('tax year 2025 has no verified daily threshold (G19 not fetched): a case that turns on it is undetermined', () => {
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 5, dailyRate: 300 }, 2025)).toBe('undetermined');
    // but 5 hours or fewer a day does not need it.
    expect(kind({ hoursPerWeek: 20, hoursPerDay: 4, dailyRate: 300 }, 2025)).toBe('non_standard_flat');
  });

  it('a director and a contractor are not classified by hours', () => {
    expect(kind({ taxStatus: 'director', hoursPerWeek: 5, hoursPerDay: 1, dailyRate: 900 })).toBe('standard');
    expect(kind({ taxStatus: 'independent_contractor', hoursPerWeek: 5 })).toBe('standard');
  });
});
