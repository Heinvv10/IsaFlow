/**
 * The company's payroll-approval lock for writers (component assign / edit / end / cancel, package apply, batch post,
 * end-date and termination-detail changes): the advisory lock approvePayrollRun takes, held to the end of `tx`, waiting
 * at most 5s. A leaf module (no payroll service imports), so the employee and termination services can take it without
 * an import cycle.
 */
import type { DbRow, TxSql } from '@/lib/neon';

const LOCK_NOT_AVAILABLE = '55P03';

export class ComponentDatesLockTimeoutError extends Error {
  readonly code = 'PAYROLL_COMPONENT_LOCK_TIMEOUT';
  constructor() {
    super('A payroll run of this company is being approved - retry in a moment.');
    this.name = 'ComponentDatesLockTimeoutError';
  }
}

/**
 * The company's payroll-approval lock (the advisory lock approvePayrollRun takes), held to the end of `tx`, waiting
 * at most 5s: no run of the company is approved while an assignment's dates change, so "already paid" cannot change
 * under the check.
 */
export async function lockCompanyPayrollForComponentChange(tx: TxSql, companyId: string): Promise<void> {
  const prev = (await tx`
    SELECT current_setting('lock_timeout', true) AS previous, set_config('lock_timeout', '5s', true) AS applied
  `) as DbRow[];
  try {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_approval:${companyId}`}, 0))`;
  } catch (err) {
    if ((err as { code?: unknown })?.code === LOCK_NOT_AVAILABLE) throw new ComponentDatesLockTimeoutError();
    throw err;
  }
  await tx`SELECT set_config('lock_timeout', ${String(prev[0]?.previous ?? '0')}, true)`;
}
