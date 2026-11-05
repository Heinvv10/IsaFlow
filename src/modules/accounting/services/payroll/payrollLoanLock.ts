import type { DbRow, TxSql } from '@/lib/neon';

/** Postgres `lock_not_available`: `lock_timeout` elapsed waiting for a lock. */
const LOCK_NOT_AVAILABLE = '55P03';

export class PayrollLoanLockTimeoutError extends Error {
  readonly code = 'PAYROLL_LOAN_LOCK_TIMEOUT';
  /** `runId` null: the wait was on the company's payroll, not one run. */
  constructor(runId: string | null) {
    super(`${runId ? `Payroll run ${runId}` : 'This company\'s payroll'} is being calculated by another request; retry in a moment.`);
    this.name = 'PayrollLoanLockTimeoutError';
  }
}

export function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/** Set the transaction-local lock timeout and return its previous value. */
export async function setLocalLockTimeout(tx: TxSql, value: string): Promise<string> {
  const rows = (await tx`
    SELECT current_setting('lock_timeout', true) AS previous,
           set_config('lock_timeout', ${value}, true) AS applied
  `) as DbRow[];
  return String(rows[0]?.previous ?? '0');
}
