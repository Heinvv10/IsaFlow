/**
 * "Ready to pay" (wave 4 B): what stops an employee's first pay run, read from what the profile already holds.
 * Pure: no fetch. `bank: 'unknown'` (not loaded, or the role may not read it) never counts as missing.
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
export interface ReadinessItem { key: 'tax' | 'pay' | 'bank'; label: string; href: string }
export interface Readiness { ready: boolean; missing: ReadinessItem[] }

export interface ReadinessInput {
  employee: { taxNumber?: string | null; paymentMethod?: string | null };
  components: ReadinessAssignment[];
  bank: BankState;
  /** YYYY-MM-DD; the run month is this date's month. */
  today?: string;
}

const day = (s: string) => String(s).slice(0, 10);

/** A running salary: an active, recurring, taxable earning that overlaps the month of `today`. */
function paysInMonth(a: ReadinessAssignment, today: string): boolean {
  if (a.componentType !== 'earning' || !a.isTaxable || !a.isRecurring || !a.componentActive) return false;
  const start = `${today.slice(0, 7)}-01`;
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const end = `${today.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  return day(a.effectiveFrom) <= end && (!a.effectiveTo || day(a.effectiveTo) >= start);
}

export function employeeReadiness({ employee, components, bank, today = todayInSast() }: ReadinessInput): Readiness {
  const missing: ReadinessItem[] = [];
  if (!isValidSarsTaxNumber(employee.taxNumber)) missing.push({ key: 'tax', label: 'a valid tax number', href: '#employee-tax-number' });
  if (!components.some(a => paysInMonth(a, today))) missing.push({ key: 'pay', label: 'a salary', href: '#employee-pay' });
  if (bank === 'none' && employee.paymentMethod !== 'cash') missing.push({ key: 'bank', label: 'bank details', href: '#employee-bank' });
  return { ready: missing.length === 0, missing };
}

export function readinessSummary(r: Readiness): string {
  if (r.ready) return 'Ready to pay';
  const n = r.missing.length;
  return `${n} ${n === 1 ? 'thing' : 'things'} before the first pay run: ${r.missing.map(m => m.label).join(', ')}`;
}
