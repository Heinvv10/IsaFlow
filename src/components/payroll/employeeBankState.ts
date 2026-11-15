import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { nextRunMonth, type BankState } from './employeeReadiness';

/**
 * Whether bank details are on file. Always the masked view: a full read writes an audit row, and readiness
 * never needs the number. A failed or refused read is 'unknown', which readiness does not call ready.
 */
export async function loadBankState(employeeId: string): Promise<BankState> {
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/bank-details?view=masked`);
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { data?: unknown };
    return json.data ? 'on-file' : 'none';
  } catch (err) {
    log.warn('bank state read failed', { error: err }, 'employeeBankState');
    return 'unknown';
  }
}

/** The month of the next pay run, from the company's run list. A failed read falls back to the current month. */
export async function loadRunMonth(): Promise<string> {
  try {
    const res = await apiFetch('/api/payroll/runs');
    if (!res.ok) return nextRunMonth([]);
    const json = (await res.json()) as { data?: Array<{ periodYear: number; periodMonth: number; status: string }> };
    return nextRunMonth(Array.isArray(json.data) ? json.data : []);
  } catch (err) {
    log.warn('run month read failed', { error: err }, 'employeeBankState');
    return nextRunMonth([]);
  }
}

/**
 * Whether the employee already has a line on a final run (so the next run is not their first). A failed or
 * malformed read is null: the copy then says "next", never "first".
 */
export async function loadHasFinalRun(employeeId: string): Promise<boolean | null> {
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/has-final-run`);
    if (!res.ok) {
      log.warn('final-run read refused', { status: res.status }, 'employeeBankState');
      return null;
    }
    const json = (await res.json()) as { data?: { hasFinalRun?: unknown } };
    return typeof json.data?.hasFinalRun === 'boolean' ? json.data.hasFinalRun : null;
  } catch (err) {
    log.warn('final-run read failed', { error: err }, 'employeeBankState');
    return null;
  }
}

export interface ReadinessState { bank: BankState; runMonth: string; hasFinalRun: boolean | null }

/**
 * The card's three facts in one read (wave 6 UXR). A failed or malformed read is the same fallback each separate
 * read had: bank 'unknown' (never ready), the current month, and a final-run answer of null ("next", never "first").
 */
export async function loadReadiness(employeeId: string): Promise<ReadinessState> {
  const failed: ReadinessState = { bank: 'unknown', runMonth: nextRunMonth([]), hasFinalRun: null };
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/readiness`);
    if (!res.ok) {
      log.warn('readiness read refused', { status: res.status }, 'employeeBankState');
      return failed;
    }
    const d = ((await res.json()) as { data?: { bank?: unknown; runs?: unknown; hasFinalRun?: unknown } }).data;
    if (d?.bank !== 'on-file' && d?.bank !== 'none') return failed;
    const runs = Array.isArray(d.runs) ? (d.runs as Array<{ periodYear: number; periodMonth: number; status: string }>) : [];
    return { bank: d.bank, runMonth: nextRunMonth(runs), hasFinalRun: typeof d.hasFinalRun === 'boolean' ? d.hasFinalRun : null };
  } catch (err) {
    log.warn('readiness read failed', { error: err }, 'employeeBankState');
    return failed;
  }
}
