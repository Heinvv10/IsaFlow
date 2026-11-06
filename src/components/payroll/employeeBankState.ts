import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BankState } from './employeeReadiness';

/**
 * Whether bank details are on file. Always the masked view: a full read writes an audit row, and readiness
 * never needs the number. A failed or refused read is 'unknown', which readiness does not count as missing.
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
