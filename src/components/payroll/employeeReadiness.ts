/**
 * "Ready to pay" (wave 4 B): what stops an employee's first pay run, read from what the profile already holds.
 * Pure: no fetch. `bank: 'unknown'` (the read failed or was refused) is not ready either.
 */
import { isValidSarsTaxNumber } from '@/modules/accounting/services/payroll/employeeFieldRules';
import { todayInSast } from '@/lib/saDateParser';

export interface ReadinessAssignment {
  componentType: string;
  isTaxable: boolean;
  isRecurring: boolean;
  componentActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}
export type BankState = 'on-file' | 'none' | 'unknown';
export interface ReadinessItem { key: 'tax' | 'pay' | 'bank' | 'bank-check'; label: string; href: string }
export interface Readiness { ready: boolean; missing: ReadinessItem[] }

export interface ReadinessInput {
  employee: { taxNumber?: string | null; paymentMethod?: string | null };
  components: ReadinessAssignment[];
  bank: BankState;
  /** YYYY-MM, the month of the next pay run (see `nextRunMonth`). Defaults to the current month. */
  runMonth?: string;
}

const day = (s: string) => String(s).slice(0, 10);

/** The run states that mean a month has been worked out: the next run is the month after the latest of these. */
const WORKED_OUT = new Set(['calculated', 'approved', 'paid']);

/** The month after the company's latest calculated / approved run, or the current month when there is none. */
export function nextRunMonth(runs: Array<{ periodYear: number; periodMonth: number; status: string }>, today: string = todayInSast()): string {
  const done = runs.filter(r => WORKED_OUT.has(r.status));
  if (done.length === 0) return today.slice(0, 7);
  const last = Math.max(...done.map(r => r.periodYear * 12 + (r.periodMonth - 1)));
  const next = last + 1;
  return `${Math.floor(next / 12)}-${String((next % 12) + 1).padStart(2, '0')}`;
}

/** A running salary: an active, recurring, taxable earning that overlaps `month` (YYYY-MM). */
function paysInMonth(a: ReadinessAssignment, month: string): boolean {
  if (a.componentType !== 'earning' || !a.isTaxable || !a.isRecurring || !a.componentActive) return false;
  // Any day of the month sorts at or before "-31", so no calendar arithmetic is needed to find the month's end.
  const [start, end] = [`${month}-01`, `${month}-31`];
  return day(a.effectiveFrom) <= end && (!a.effectiveTo || day(a.effectiveTo) >= start);
}

export function employeeReadiness({ employee, components, bank, runMonth = todayInSast().slice(0, 7) }: ReadinessInput): Readiness {
  const missing: ReadinessItem[] = [];
  if (!isValidSarsTaxNumber(employee.taxNumber)) missing.push({ key: 'tax', label: 'a valid tax number', href: '#employee-tax-number' });
  if (!components.some(a => paysInMonth(a, runMonth))) missing.push({ key: 'pay', label: 'a salary', href: '#employee-pay' });
  if (employee.paymentMethod !== 'cash') {
    // An unanswered read is never "ready": a transient failure must not read as a good bill of health.
    if (bank === 'none') missing.push({ key: 'bank', label: 'bank details', href: '#employee-bank' });
    if (bank === 'unknown') missing.push({ key: 'bank-check', label: 'Could not check bank details', href: '#employee-bank' });
  }
  return { ready: missing.length === 0, missing };
}

export function readinessSummary(r: Readiness): string {
  if (r.ready) return 'Ready to pay';
  const n = r.missing.length;
  return `${n} ${n === 1 ? 'thing' : 'things'} before the first pay run: ${r.missing.map(m => m.label).join(', ')}`;
}
