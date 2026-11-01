/**
 * createEmployeeWithPay: every field is judged before the first write (a 4xx commits, rule 9), the salary goes in as
 * rands from whole cents, and it starts on the start date. Malformed shapes are in the first test, not a review round.
 * A lost race on the employee number is a refusal too, with nothing written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ component: null as Record<string, unknown> | null, duplicate: false }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (parts: TemplateStringsArray) => {
    const text = parts.join('?');
    if (text.includes('FROM payroll_components')) return db.component ? [db.component] : [];
    if (text.includes('FROM payroll_employees')) return db.duplicate ? [{ id: 'dup' }] : [];
    throw new Error(`unexpected query: ${text}`);
  }),
  withSavepoint: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  createPayrollEmployee: vi.fn(async () => ({ id: 'e1' })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeComponentService', () => ({
  assignComponentToEmployee: vi.fn(async () => ({ id: 'a1' })),
}));

import { sql, withSavepoint } from '@/lib/neon';
import { createPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import {
  createEmployeeWithPay, employeeChangesOf, EmployeeOnboardingRefused,
} from '@/modules/accounting/services/payroll/payrollEmployeeOnboarding';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const COMPONENT = '22222222-2222-4222-8222-222222222222';
const BASE = { firstName: 'Thandi', lastName: 'Nkosi', employeeNumber: 'E-1', employmentType: 'permanent', startDate: '2026-11-01' };
const EARNING = { sars_source_code: '3601', component_type: 'earning', is_active: true, is_taxable: true };
const go = (over: Record<string, unknown> = {}) => createEmployeeWithPay(COMPANY, 'u1', { ...BASE, ...over });
const withSalary = (salary: unknown) => go({ salary });

beforeEach(() => {
  vi.clearAllMocks();
  db.component = { ...EARNING };
  db.duplicate = false;
});

async function expectRefused(run: Promise<unknown>, reason: RegExp) {
  const err = await run.then(() => null, e => e as Error);
  expect(err).toBeInstanceOf(EmployeeOnboardingRefused);
  expect(err?.message).toMatch(reason);
  expect(createPayrollEmployee).not.toHaveBeenCalled();
  expect(assignComponentToEmployee).not.toHaveBeenCalled();
}

describe('createEmployeeWithPay: refused before the first write', () => {
  it.each([
    ['firstName', { firstName: '   ' }, /firstName/],
    ['firstName array', { firstName: ['Thandi'] }, /firstName/],
    ['lastName missing', { lastName: undefined }, /lastName/],
    ['employeeNumber object', { employeeNumber: { toString: () => 'E-1' } }, /employeeNumber/],
    ['employeeNumber too long', { employeeNumber: 'E'.repeat(21) }, /employeeNumber/],
    ['firstName too long', { firstName: 'x'.repeat(101) }, /firstName/],
    ['employmentType', { employmentType: 'intern' }, /employmentType/],
    ['startDate missing', { startDate: undefined }, /startDate/],
    ['startDate rolls over', { startDate: '2026-02-31' }, /startDate/],
    ['startDate not a date', { startDate: 'tomorrow' }, /startDate/],
    ['dateOfBirth', { dateOfBirth: '1980-13-01' }, /dateOfBirth/],
    ['endDate', { endDate: 'soon' }, /endDate/],
    ['tax number letters', { taxNumber: 'ABC1234567' }, /tax number/i],
    ['tax number bad first digit', { taxNumber: '4123456789' }, /tax number/i],
    ['tax number nine digits', { taxNumber: '123456789' }, /tax number/i],
    ['tax number array', { taxNumber: ['1234567890'] }, /tax number/i],
    ['id number short', { idNumber: '800101500908' }, /ID number/i],
    ['id number number', { idNumber: 8001015009087 }, /ID number/i],
    ['dependants negative', { medicalAidDependantsCount: -1 }, /dependants/i],
    ['dependants fraction', { medicalAidDependantsCount: 1.5 }, /dependants/i],
    ['uifExcluded the string false', { uifExcluded: 'false' }, /uifExcluded/],
    ['uifExcluded a number', { uifExcluded: 1 }, /uifExcluded/],
    ['endDate before startDate', { endDate: '2026-10-31' }, /endDate/],
  ])('%s', async (_n, over, reason) => {
    await expectRefused(go(over), reason);
  });

  it.each([
    ['not an object', 'Basic'],
    ['an array', [COMPONENT, 2500000]],
    ['componentId missing', { amountCents: 2500000 }],
    ['componentId array', { componentId: [COMPONENT], amountCents: 2500000 }],
    ['componentId not a uuid', { componentId: 'basic', amountCents: 2500000 }],
  ])('salary: %s', async (_n, salary) => {
    await expectRefused(withSalary(salary), /salary|component/i);
  });

  it.each([
    ['zero', 0], ['negative', -100], ['sub-cent', 100.5], ['a string', '2500000'], ['true', true], ['an array', [2500000]],
    ['null', null], ['NaN', Number.NaN], ['too big for the column', 100_000_000_000_000],
  ])('salary amountCents: %s', async (_n, amountCents) => {
    await expectRefused(withSalary({ componentId: COMPONENT, amountCents }), /whole cents/i);
  });

  it.each([
    ['alone', { componentId: COMPONENT, amount: 25000 }],
    ['beside amountCents', { componentId: COMPONENT, amount: 25000, amountCents: 2500000 }],
  ])('salary.amount %s is refused: a caller thinking in rands cannot store R250', async (_n, salary) => {
    await expectRefused(withSalary(salary), /amountCents/);
  });

  it.each([
    ['unknown or another company', null, /not found/i],
    ['inactive', { ...EARNING, is_active: false }, /inactive/i],
    ['a deduction', { ...EARNING, component_type: 'deduction' }, /earning/i],
    ['an employer contribution', { ...EARNING, component_type: 'employer_contribution' }, /earning/i],
    ['an annual payment', { ...EARNING, sars_source_code: '3605' }, /monthly/i],
    ['an annual payment, spaced', { ...EARNING, sars_source_code: ' 3605\n' }, /monthly/i],
    ['a lump sum', { ...EARNING, sars_source_code: '3901' }, /monthly/i],
    ['not taxable', { ...EARNING, is_taxable: false }, /taxable/i],
  ])('component: %s', async (_n, row, reason) => {
    db.component = row;
    await expectRefused(withSalary({ componentId: COMPONENT, amountCents: 2500000 }), reason);
  });

  it('an employee number already in use', async () => {
    db.duplicate = true;
    await expectRefused(go(), /already in use/i);
  });

  it('reads the component by this company, and the employee number by this company', async () => {
    await withSalary({ componentId: COMPONENT, amountCents: 2500000 });
    const calls = vi.mocked(sql).mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>;
    expect(calls).toHaveLength(2);
    for (const [parts, ...values] of calls) {
      expect(parts.join('?')).toMatch(/company_id = \?::uuid/);
      expect(values).toContain(COMPANY);
    }
  });
});

describe('createEmployeeWithPay: what it writes', () => {
  it('no salary: an employee and no component', async () => {
    await expect(go()).resolves.toEqual({ id: 'e1' });
    expect(createPayrollEmployee).toHaveBeenCalledTimes(1);
    expect(assignComponentToEmployee).not.toHaveBeenCalled();
  });

  it.each([[undefined], [null]])('salary %j is no salary', async (salary) => {
    await withSalary(salary);
    expect(assignComponentToEmployee).not.toHaveBeenCalled();
  });

  it('the salary is stored in rands, recurring, from the start date', async () => {
    await withSalary({ componentId: COMPONENT, amountCents: 2500050 });
    expect(assignComponentToEmployee).toHaveBeenCalledTimes(1);
    const [company, employee, component, rands, from, to, recurring] = vi.mocked(assignComponentToEmployee).mock.calls[0]!;
    expect([company, employee, component, rands, to, recurring]).toEqual([COMPANY, 'e1', COMPONENT, 25000.5, undefined, true]);
    // assignComponentToEmployee renders this with toISOString(): a local-midnight Date would land on 31 Oct in SAST.
    expect(from.toISOString().slice(0, 10)).toBe('2026-11-01');
  });

  it('the employee is written first: the assignment needs its id', async () => {
    await withSalary({ componentId: COMPONENT, amountCents: 100 });
    expect(vi.mocked(createPayrollEmployee).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(assignComponentToEmployee).mock.invocationCallOrder[0]!);
  });

  it('a failed assignment is not a refusal: it rethrows, so the request rolls back', async () => {
    vi.mocked(assignComponentToEmployee).mockRejectedValueOnce(new Error('boom'));
    const err = await withSalary({ componentId: COMPONENT, amountCents: 100 }).then(() => null, e => e as Error);
    expect(err?.message).toBe('boom');
    expect(err).not.toBeInstanceOf(EmployeeOnboardingRefused);
  });

  it('identifiers and names go in trimmed, so a padded ID cannot overflow its column', async () => {
    await go({ firstName: ' Thandi ', taxNumber: ' 0123456789 ', idNumber: ' 8001015009087 ' });
    const data = vi.mocked(createPayrollEmployee).mock.calls[0]![1];
    expect(data).toMatchObject({ firstName: 'Thandi', taxNumber: '0123456789', idNumber: '8001015009087' });
  });

  it.each([[true, true], [false, false], [undefined, false], [null, false]])('uifExcluded %j is stored as %j', async (uifExcluded, stored) => {
    await go({ uifExcluded });
    expect(vi.mocked(createPayrollEmployee).mock.calls[0]![1].uifExcluded).toBe(stored);
  });

  it('an end date on the start date is allowed', async () => {
    await go({ endDate: BASE.startDate });
    expect(createPayrollEmployee).toHaveBeenCalledTimes(1);
  });

  it('empty optional fields are absent, not refused', async () => {
    await go({ taxNumber: '', idNumber: '', dateOfBirth: '', endDate: null });
    const data = vi.mocked(createPayrollEmployee).mock.calls[0]![1];
    expect(data).toMatchObject({ taxNumber: undefined, idNumber: undefined, dateOfBirth: undefined, endDate: undefined });
  });
});

describe('createEmployeeWithPay: a lost race on the employee number', () => {
  /** As pg raises it: the pre-check passed, then the insert died on the unique constraint. */
  const duplicate = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
  const lose = () => {
    vi.mocked(createPayrollEmployee).mockImplementationOnce(async () => {
      db.duplicate = true; // the row the other request committed is there on the re-read
      throw duplicate();
    });
  };

  it('23505 and the number is taken: a refusal, and no salary is assigned', async () => {
    lose();
    const err = await withSalary({ componentId: COMPONENT, amountCents: 100 }).then(() => null, e => e as Error);
    expect(err).toBeInstanceOf(EmployeeOnboardingRefused);
    expect(err?.message).toMatch(/already in use/i);
    expect(assignComponentToEmployee).not.toHaveBeenCalled();
  });

  it('runs the insert in its own savepoint: a failed insert would abort the request transaction', async () => {
    lose();
    await go().catch(() => undefined);
    expect(withSavepoint).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withSavepoint).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(createPayrollEmployee).mock.invocationCallOrder[0]!);
  });

  it('23505 on anything else, with the number still free: the original error, not a false refusal', async () => {
    const original = duplicate();
    vi.mocked(createPayrollEmployee).mockRejectedValueOnce(original);
    await expect(go()).rejects.toBe(original);
  });

  it('any other failure of the insert stays a failure, whatever the number looks like by then', async () => {
    vi.mocked(createPayrollEmployee).mockImplementationOnce(async () => {
      db.duplicate = true;
      throw Object.assign(new Error('boom'), { code: '23514' });
    });
    const err = await go().then(() => null, e => e as Error);
    expect(err?.message).toBe('boom');
    expect(err).not.toBeInstanceOf(EmployeeOnboardingRefused);
  });
});

describe('employeeChangesOf: the date of birth that goes on is the day that was judged', () => {
  const current = { startDate: new Date('2020-01-01') };

  it.each([['a plain day', '1980-05-01'], ['the API timestamp', '1980-05-01T00:00:00.000Z']])('%s comes back as the day', (_n, dateOfBirth) => {
    expect(employeeChangesOf({ dateOfBirth }, current).dateOfBirth).toBe('1980-05-01');
  });

  it.each([[''], [null], [undefined]])('%j is left as it came: blank means no change', (dateOfBirth) => {
    expect(employeeChangesOf({ dateOfBirth }, current).dateOfBirth).toBe(dateOfBirth);
  });

  it.each([['1980-05-01 BC'], ['1980-05-01junk'], ['1980-02-31'], ['T00:00:00.000Z1980-05-01'], [19800501]])('%j is refused', (dateOfBirth) => {
    expect(() => employeeChangesOf({ dateOfBirth }, current)).toThrow(/dateOfBirth must be a real date/);
  });
});

describe('employeeChangesOf: the end date that goes on is the day that was judged', () => {
  const current = { startDate: new Date('2020-01-01'), endDate: new Date('2030-06-30') };

  it.each([
    ['a plain day', '2030-12-31', '2030-12-31'],
    ['the timestamp the API answers with', '2030-12-31T00:00:00.000Z', '2030-12-31'],
    ['the stored day, as that timestamp', '2030-06-30T00:00:00.000Z', '2030-06-30'],
  ])('%s comes back as the day', (_n, endDate, day) => {
    expect(employeeChangesOf({ endDate }, current).endDate).toBe(day);
  });

  it.each([[''], [null], [undefined]])('%j is left as it came: blank means no change', (endDate) => {
    expect(employeeChangesOf({ endDate }, current).endDate).toBe(endDate);
  });

  it.each([
    ['2030-12-31 BC'], ['2030-12-31junk'], ['2030-12-31T00:00:00Z'], ['2030-12-31T23:59:59.999Z'], ['2030-06-30x'], ['2030-02-31'], [['2030-12-31']],
    ['T00:00:00.000Z2030-12-31'],
  ])('%j is refused', (endDate) => {
    expect(() => employeeChangesOf({ endDate }, current)).toThrow(EmployeeOnboardingRefused);
  });
});
