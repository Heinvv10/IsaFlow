/**
 * The payroll oracle's fixture guard (tests/fixtures/payroll-oracle/validate.ts): personal-data
 * masking, shape, tolerance cap, and the gap-list rules (oracle.ts gapListProblems).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoPersonalData, validateCase } from '../../../fixtures/payroll-oracle/validate';
import { gapListProblems, ORACLE_DIR, type KnownGap, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

const FILE = 'uif-ceiling-20000.json';
const base = (): Record<string, unknown> => JSON.parse(readFileSync(join(ORACLE_DIR, FILE), 'utf8')) as Record<string, unknown>;
const input = (c: Record<string, unknown>) => c.input as Record<string, unknown>;
const employee = (c: Record<string, unknown>) => input(c).employee as Record<string, unknown>;

describe('oracle fixture guard: personal data', () => {
  it('a real fixture passes', () => {
    expect(() => validateCase(base(), FILE)).not.toThrow();
  });

  it.each(['first_name', 'FirstName', 'id_number', 'IDNumber', 'surname', 'tax-ref', 'bankAccount', 'mobile', 'passportNo', 'dob'])(
    'refuses a key like %s, at the top or inside the employee',
    (key) => {
      const top = { ...base(), [key]: 'x' };
      expect(() => validateCase(top, FILE)).toThrow(/looks like personal data/);
      const nested = base();
      employee(nested)[key] = 'x';
      expect(() => validateCase(nested, FILE)).toThrow(/looks like personal data/);
    },
  );

  it('refuses a personal-data key inside unmodelled, where no schema key is exempt', () => {
    const c = base();
    input(c).unmodelled = { employeeName: 'x' };
    expect(() => validateCase(c, FILE)).toThrow(/input\.unmodelled\.employeeName.*personal data/);
  });

  it('refuses an ID number (13 digits, spaced or not) or an email inside notes', () => {
    for (const notes of ['Employee 8001015009087 paid', 'ID 800101 5009 087', 'mail a.person@example.co.za']) {
      expect(() => validateCase({ ...base(), notes }, FILE), notes).toThrow(/holds (a 13-digit number|an email address)/);
    }
  });

  it('keeps only the birth year: a full date of birth is refused', () => {
    const c = base();
    employee(c).dateOfBirth = '1986-07-14';
    expect(() => validateCase(c, FILE)).toThrow(/YYYY-01-01/);
  });

  it('assertNoPersonalData exempts schema keys only in their own place', () => {
    expect(() => assertNoPersonalData({ input: { employee: { dateOfBirth: null, taxStatus: 's' } } }, FILE)).not.toThrow();
    expect(() => assertNoPersonalData({ input: { unmodelled: { taxStatus: 's' } } }, FILE)).toThrow(/personal data/);
  });
});

describe('oracle fixture guard: shape and tolerance', () => {
  it('names a missing employee field and a missing components array', () => {
    const a = base();
    delete employee(a).uifExcluded;
    expect(() => validateCase(a, FILE)).toThrow(/uif-ceiling-20000\.json: input\.employee\.uifExcluded must be a boolean/);
    const b = base();
    delete input(b).components;
    expect(() => validateCase(b, FILE)).toThrow(/input\.components must be a non-empty array/);
  });

  it('refuses an unknown key, a bad source, and an id that is not the file name', () => {
    expect(() => validateCase({ ...base(), extra: 1 }, FILE)).toThrow(/unknown key/);
    expect(() => validateCase({ ...base(), source: 'guess' }, FILE)).toThrow(/source "guess"/);
    expect(() => validateCase(base(), 'other.json')).toThrow(/must match the file name/);
  });

  it('caps tolerance at 5 cents and requires a non-empty reason', () => {
    const ok = { ...base(), tolerance: { paye: { cents: 5, reason: 'documented rounding', engineActual: 1 } } };
    expect(() => validateCase(ok, FILE)).not.toThrow();
    expect(() => validateCase({ ...base(), tolerance: { paye: { cents: 6, reason: 'r', engineActual: 1 } } }, FILE)).toThrow(/from 1 to 5/);
    expect(() => validateCase({ ...base(), tolerance: { paye: { cents: 2, reason: '  ', engineActual: 1 } } }, FILE)).toThrow(/a reason is required/);
    expect(() => validateCase({ ...base(), tolerance: { eti: { cents: 2, reason: 'r', engineActual: 1 } } }, FILE)).not.toThrow();
    expect(() => validateCase({ ...base(), tolerance: { paye: { cents: 2, reason: 'r' } } }, FILE)).toThrow(/engineActual/);
  });
});

describe('oracle gap list rules', () => {
  const c = (id: string, source = 'sage'): OracleCase => ({ ...(base() as unknown as OracleCase), id, source });
  const gap = (id: string, engineActual: KnownGap['engineActual']): KnownGap => ({ case: id, engineActual, reason: 'a reason long enough to count', closedBy: 'W3 item' });

  it('refuses an UNVERIFIED case that is not on the gap list', () => {
    expect(gapListProblems([c('a', 'UNVERIFIED')], [])).toEqual(['a: source UNVERIFIED must be on knownGaps.json (engine differs) or unverified.json (engine matches)']);
    expect(gapListProblems([c('a', 'UNVERIFIED')], [gap('a', { paye: 1 })])).toEqual([]);
  });

  it('refuses a gap with no fixture, a duplicate, an empty or non-asserted field', () => {
    expect(gapListProblems([c('a')], [gap('b', { paye: 1 })])).toContain('b: on knownGaps but has no fixture');
    expect(gapListProblems([c('a')], [gap('a', { paye: 1 }), gap('a', { net: 1 })])).toContain('a: listed twice');
    expect(gapListProblems([c('a')], [gap('a', {})])).toContain('a: engineActual is empty');
  });
});

describe('oracle fixture guard: wave-6 period and prior-period schema (O3)', () => {
  const STARTER = 'weekly-starter-fourth-week-averaged.json';
  const starter = (): Record<string, unknown> => JSON.parse(readFileSync(join(ORACLE_DIR, STARTER), 'utf8')) as Record<string, unknown>;
  const period = (c: Record<string, unknown>) => input(c).period as Record<string, unknown>;
  const prior0 = (c: Record<string, unknown>) => (input(c).priorPeriods as Record<string, unknown>[])[0]!;

  it('a real fixture with a frequency, period dates, a run kind and priors passes', () => {
    expect(() => validateCase(starter(), STARTER)).not.toThrow();
  });

  it('refuses an unknown frequency or run kind, a lone period date, dates out of order, outside the tax year or off the pay month', () => {
    const bad = (edit: (p: Record<string, unknown>) => void, msg: RegExp) => {
      const c = starter(); edit(period(c)); expect(() => validateCase(c, STARTER)).toThrow(msg);
    };
    bad(p => { p.frequency = 'daily'; }, /frequency must be one of/);
    bad(p => { p.runKind = 'advance'; }, /runKind must be one of/);
    bad(p => { delete p.periodEnd; }, /periodStart and periodEnd together/);
    bad(p => { p.periodEnd = '2026-07-19'; }, /in order and inside tax year/);
    bad(p => { p.periodStart = '2027-03-01'; p.periodEnd = '2027-03-07'; }, /inside tax year/);
    bad(p => { p.periodStart = '2026-02-30'; }, /real YYYY-MM-DD/);
    bad(p => { p.month = 9; }, /overlap its pay month/);
    bad(p => { p.payDay = 'Friday'; }, /unknown key/);
  });

  it('refuses an empty prior list, an unknown or missing prior key, a prior after this period and a personal-data key in one', () => {
    const c = starter(); input(c).priorPeriods = [];
    expect(() => validateCase(c, STARTER)).toThrow(/non-empty array/);
    const bad = (edit: (p: Record<string, unknown>) => void, msg: RegExp) => {
      const x = starter(); edit(prior0(x)); expect(() => validateCase(x, STARTER)).toThrow(msg);
    };
    bad(p => { delete p.etiHours; }, /priorPeriods\[0\]\.etiHours must be a number/);
    bad(p => { p.sdl = 1; }, /priorPeriods\[0\] has unknown key/);
    bad(p => { p.periodStart = '2026-07-27'; }, /periodStart must be a real date from/);
    bad(p => { p.frequency = 'annual'; }, /frequency must be one of/);
    bad(p => { p.employeeTaxRef = 'x'; }, /looks like personal data/);
  });
});

describe('oracle list rules: unverified.json (O3)', () => {
  const c = (id: string, source = 'UNVERIFIED'): OracleCase => ({ ...(base() as unknown as OracleCase), id, source });
  const gap = (id: string): KnownGap => ({ case: id, engineActual: { paye: 1 }, reason: 'a reason long enough to count', closedBy: 'W3 item' });
  const un = (id: string, reason = 'a reason long enough to count', wouldVerify = 'what would verify it, long enough') => ({ case: id, reason, wouldVerify });

  it('an UNVERIFIED case on unverified.json alone is fine; on both lists or with a cited source it is refused', () => {
    expect(gapListProblems([c('a')], [], [un('a')])).toEqual([]);
    expect(gapListProblems([c('a')], [gap('a')], [un('a')])).toContain('a: on both knownGaps.json and unverified.json');
    expect(gapListProblems([c('a', 'sage')], [], [un('a')])).toContain('a: on unverified.json but its source is sage');
  });

  it('refuses an entry with no fixture, a duplicate, and a missing reason or wouldVerify', () => {
    expect(gapListProblems([c('a')], [gap('a')], [un('b')])).toContain('b: on unverified.json but has no fixture');
    expect(gapListProblems([c('a')], [], [un('a'), un('a')])).toContain('a: listed twice on unverified.json');
    expect(gapListProblems([c('a')], [], [un('a', 'short')])).toContain('a: unverified reason missing');
    expect(gapListProblems([c('a')], [], [un('a', undefined, '')])).toContain('a: unverified wouldVerify missing');
  });
});
