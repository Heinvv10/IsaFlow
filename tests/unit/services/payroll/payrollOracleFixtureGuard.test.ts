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
    const ok = { ...base(), tolerance: { paye: { cents: 5, reason: 'documented rounding' } } };
    expect(() => validateCase(ok, FILE)).not.toThrow();
    expect(() => validateCase({ ...base(), tolerance: { paye: { cents: 6, reason: 'r' } } }, FILE)).toThrow(/from 1 to 5/);
    expect(() => validateCase({ ...base(), tolerance: { paye: { cents: 2, reason: '  ' } } }, FILE)).toThrow(/a reason is required/);
    expect(() => validateCase({ ...base(), tolerance: { eti: { cents: 2, reason: 'r' } } }, FILE)).not.toThrow();
  });
});

describe('oracle gap list rules', () => {
  const c = (id: string, source = 'sage'): OracleCase => ({ ...(base() as unknown as OracleCase), id, source });
  const gap = (id: string, engineActual: KnownGap['engineActual']): KnownGap => ({ case: id, engineActual, reason: 'a reason long enough to count', closedBy: 'W3 item' });

  it('refuses an UNVERIFIED case that is not on the gap list', () => {
    expect(gapListProblems([c('a', 'UNVERIFIED')], [])).toEqual(['a: source UNVERIFIED is allowed only on a known gap']);
    expect(gapListProblems([c('a', 'UNVERIFIED')], [gap('a', { paye: 1 })])).toEqual([]);
  });

  it('refuses a gap with no fixture, a duplicate, an empty or non-asserted field', () => {
    expect(gapListProblems([c('a')], [gap('b', { paye: 1 })])).toContain('b: on knownGaps but has no fixture');
    expect(gapListProblems([c('a')], [gap('a', { paye: 1 }), gap('a', { net: 1 })])).toContain('a: listed twice');
    expect(gapListProblems([c('a')], [gap('a', {})])).toContain('a: engineActual is empty');
  });
});
