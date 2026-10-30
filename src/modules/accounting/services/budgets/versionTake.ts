/**
 * The version compare-and-set every budget write that carries the client's token takes (P2's grid
 * save, P4's driver and planned-hire writes; moved unchanged from gridSave.ts). It is P1's pre-lock
 * (`lockVersionForWrite`) plus the CAS: one UPDATE bumps `updated_at` only when the version is the
 * company's, still holds the client's token and is not locked, taking the row lock (bounded wait).
 * Otherwise it says why: 404 NOT_FOUND, 409 LOCKED, or 409 STALE with what the version is now.
 */
import { sql, type DbRow } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { BudgetVersionError, type BudgetVersionStatus } from './budgetVersionTypes';
import { tokenSql } from './gridErrors';

/** 409 BUDGET_VERSION_STALE, with what the version is now (for the stale-version dialog). */
export class BudgetVersionStaleError extends BudgetVersionError {
  constructor(readonly currentUpdatedAt: string, readonly versionStatus: BudgetVersionStatus) {
    super('BUDGET_VERSION_STALE', 'This budget changed since you opened it; reload and re-apply your changes');
  }
}

/**
 * The compare-and-set: bumps the version's updated_at only when it is the company's, still holds
 * the client's token and is not locked, taking the row lock (bounded wait). Otherwise says why.
 */
export async function takeVersion(companyId: string, versionId: string, expected: string) {
  const rows = (await withRowLockBudget(
    () => sql`
      UPDATE budget_versions SET updated_at = clock_timestamp()
       WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
         AND updated_at = ${expected}::TIMESTAMPTZ AND status <> 'locked'
      RETURNING fiscal_year, status, ${tokenSql()} AS token
    `,
    () => new RowLockTimeoutError('This budget version'),
  )) as DbRow[];
  if (rows[0]) {
    return { fiscalYear: Number(rows[0].fiscal_year), status: String(rows[0].status) as BudgetVersionStatus, updatedAt: String(rows[0].token) };
  }
  const now = (await sql`
    SELECT status, ${tokenSql()} AS token
      FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!now[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  if (now[0].status === 'locked') throw new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked');
  throw new BudgetVersionStaleError(String(now[0].token), String(now[0].status) as BudgetVersionStatus);
}
