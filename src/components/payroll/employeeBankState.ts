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
