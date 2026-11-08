/**
 * The terms of work on an employee (migration 967): tax status, pay basis, hours, rates, occupation.
 * Judged before any write, so a refused body changes no row (a 4xx commits). Nothing in the calculator reads
 * them yet (TS-b does); `tax_status` is the one source of truth for "director", `employment_type` is display and HR.
 */
import type { PayBasis, PayrollEmployee, TaxStatus } from './payrollTypes';

export const TAX_STATUSES: readonly TaxStatus[] = ['employee', 'director', 'independent_contractor'];
export const PAY_BASES: readonly PayBasis[] = ['monthly', 'hourly', 'daily'];
const MAX_OCCUPATION = 100;
const MAX_RATE = 9_999_999_999.99; // NUMERIC(12,2)

export type EmployeeTerms = Pick<
  PayrollEmployee, 'taxStatus' | 'payBasis' | 'hoursPerWeek' | 'hoursPerDay' | 'hourlyRate' | 'dailyRate' | 'occupation'
>;
export const DEFAULT_TERMS: EmployeeTerms = {
  taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: null, hoursPerDay: null, hourlyRate: null, dailyRate: null, occupation: null,
};
export const TERM_KEYS = ['taxStatus', 'payBasis', 'hoursPerWeek', 'hoursPerDay', 'hourlyRate', 'dailyRate', 'occupation'] as const;

type Body = Record<string, unknown>;

/** A route's request-log mask (withErrorHandler maskBodyKeys): the terms are pay detail, never logged. */
export const EMPLOYEE_TERM_LOG_KEYS: readonly string[] = [...TERM_KEYS];

/** Status and rates decide what an employee costs: only the roles that may redirect net pay may move them. */
const PRICED_KEYS = ['taxStatus', 'payBasis', 'hourlyRate', 'dailyRate'] as const;

/** Whether a judged patch changes one of the priced terms from `current` (an unchanged value is no change). */
export function movesPricedTerm(patch: Partial<EmployeeTerms>, current: EmployeeTerms): boolean {
  return PRICED_KEYS.some((k) => patch[k] !== undefined && patch[k] !== current[k]);
}

/** Raised before the first write; the callers answer it as a 400 (the onboarding error class does). */
export type Refuse = (message: string) => Error;

const isBlank = (v: unknown) => v === undefined || v === null || v === '';
const twoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string, refuse: Refuse): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw refuse(`${key} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

function bounded(value: unknown, key: string, max: number, refuse: Refuse): number | null {
  if (isBlank(value)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || !twoDecimals(value)) {
    throw refuse(`${key} must be more than 0 and at most ${max}, to two decimals`);
  }
  return value;
}

function rate(value: unknown, key: string, refuse: Refuse): number | null {
  if (isBlank(value)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_RATE || !twoDecimals(value)) {
    throw refuse(`${key} must be 0 or more, in rands to two decimals`);
  }
  return value;
}

function occupationOf(value: unknown, refuse: Refuse): string | null {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw refuse('occupation must be text');
  // Control characters (newlines, NUL, escapes) have no place in a payslip line.
  const text = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (text.length > MAX_OCCUPATION) throw refuse(`occupation must be at most ${MAX_OCCUPATION} characters`);
  return text || null;
}

/** Create: absent terms take the column defaults (employee, monthly, nothing else). */
export function termsOfCreate(body: Body, refuse: Refuse): EmployeeTerms {
  return judgeTerms({
    taxStatus: isBlank(body.taxStatus) ? 'employee' : oneOf(body.taxStatus, TAX_STATUSES, 'taxStatus', refuse),
    payBasis: isBlank(body.payBasis) ? 'monthly' : oneOf(body.payBasis, PAY_BASES, 'payBasis', refuse),
    hoursPerWeek: bounded(body.hoursPerWeek, 'hoursPerWeek', 168, refuse),
    hoursPerDay: bounded(body.hoursPerDay, 'hoursPerDay', 24, refuse),
    hourlyRate: rate(body.hourlyRate, 'hourlyRate', refuse),
    dailyRate: rate(body.dailyRate, 'dailyRate', refuse),
    occupation: occupationOf(body.occupation, refuse),
  }, refuse);
}

/**
 * What the migration's CHECKs refuse across columns, refused here first so the app and the database agree: an hourly
 * employee needs an hourly rate above 0, a daily one a daily rate above 0, and a day cannot be longer than the week.
 * A monthly employee may carry hours (TS-b and ET read them).
 */
export function judgeTerms(t: EmployeeTerms, refuse: Refuse): EmployeeTerms {
  if (t.payBasis === 'hourly' && !(t.hourlyRate != null && t.hourlyRate > 0)) throw refuse('An hourly employee needs an hourlyRate above 0');
  if (t.payBasis === 'daily' && !(t.dailyRate != null && t.dailyRate > 0)) throw refuse('A daily employee needs a dailyRate above 0');
  if (t.hoursPerDay != null && t.hoursPerWeek != null && t.hoursPerDay > t.hoursPerWeek) {
    throw refuse('hoursPerDay cannot be more than hoursPerWeek');
  }
  return t;
}

/**
 * Patch: only the keys present are judged and returned. A blank clears a hours/rate/occupation term; a tax status or
 * pay basis cannot be blank (they are NOT NULL), so a blank one is refused rather than ignored.
 */
export function termsOfPatch(body: Body, refuse: Refuse, current: EmployeeTerms = DEFAULT_TERMS): Partial<EmployeeTerms> {
  const out: Partial<EmployeeTerms> = {};
  if (body.taxStatus !== undefined) out.taxStatus = oneOf(body.taxStatus, TAX_STATUSES, 'taxStatus', refuse);
  if (body.payBasis !== undefined) out.payBasis = oneOf(body.payBasis, PAY_BASES, 'payBasis', refuse);
  if (body.hoursPerWeek !== undefined) out.hoursPerWeek = bounded(body.hoursPerWeek, 'hoursPerWeek', 168, refuse);
  if (body.hoursPerDay !== undefined) out.hoursPerDay = bounded(body.hoursPerDay, 'hoursPerDay', 24, refuse);
  if (body.hourlyRate !== undefined) out.hourlyRate = rate(body.hourlyRate, 'hourlyRate', refuse);
  if (body.dailyRate !== undefined) out.dailyRate = rate(body.dailyRate, 'dailyRate', refuse);
  if (body.occupation !== undefined) out.occupation = occupationOf(body.occupation, refuse);
  // The cross-column rules judge the terms as they would stand after the patch.
  if (Object.keys(out).length > 0) judgeTerms({ ...current, ...out }, refuse);
  return out;
}

/** "Director" employment type with an employee tax status: the card asks, nothing changes silently (grill 24). */
export function directorStatusPrompt(e: Pick<PayrollEmployee, 'employmentType' | 'taxStatus'>): string | null {
  return e.employmentType === 'director' && e.taxStatus === 'employee' ? 'Set tax status to Director?' : null;
}

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** The terms as stored: NUMERIC arrives from pg as text. A column the row does not carry (a fixture) is the default; a value the CHECK cannot have stored throws. */
export function termsFromRow(r: Record<string, unknown>): EmployeeTerms {
  return {
    taxStatus: oneOf(r.tax_status === undefined ? 'employee' : r.tax_status, TAX_STATUSES, 'tax_status', (m) => new Error(`Stored ${m}`)),
    payBasis: oneOf(r.pay_basis === undefined ? 'monthly' : r.pay_basis, PAY_BASES, 'pay_basis', (m) => new Error(`Stored ${m}`)),
    hoursPerWeek: numOrNull(r.hours_per_week),
    hoursPerDay: numOrNull(r.hours_per_day),
    hourlyRate: numOrNull(r.hourly_rate),
    dailyRate: numOrNull(r.daily_rate),
    occupation: r.occupation == null ? null : String(r.occupation),
  };
}

const COLUMN_OF: Record<(typeof TERM_KEYS)[number], string> = {
  taxStatus: 'tax_status', payBasis: 'pay_basis', hoursPerWeek: 'hours_per_week', hoursPerDay: 'hours_per_day',
  hourlyRate: 'hourly_rate', dailyRate: 'daily_rate', occupation: 'occupation',
};

/** The terms a patch moved, as history rows (old and new as text), for the change log. */
export function movedTerms(before: EmployeeTerms, after: EmployeeTerms): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
  const text = (v: unknown) => (v == null ? null : String(v));
  return TERM_KEYS
    .filter((k) => text(before[k]) !== text(after[k]))
    .map((k) => ({ field: COLUMN_OF[k], oldValue: text(before[k]), newValue: text(after[k]) }));
}
