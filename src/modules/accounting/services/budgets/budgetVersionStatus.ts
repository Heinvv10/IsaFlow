/**
 * Approve, lock and unlock a budget version (decisions 1, 2 and 11). Approve and lock: owner or
 * admin. Unlock: owner only, with a reason (1-500 characters). Each move is a compare-and-set on the
 * status the move starts from, and optionally on `expectedUpdatedAt` (the client's last read), so of
 * two concurrent moves one wins and the other is a 409. The audit row is written by the database
 * (budget_versions_audit, migration 947), never here, so no path can move a version unaudited.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { getVersion, type VersionActor } from './budgetVersions';
import { BudgetVersionError, type BudgetVersion, type BudgetVersionStatus } from './budgetVersionTypes';

export type VersionAction = 'approve' | 'lock' | 'unlock';

const MOVES: Record<VersionAction, { from: BudgetVersionStatus; to: BudgetVersionStatus; roles: readonly string[] }> = {
  approve: { from: 'draft', to: 'approved', roles: ['owner', 'admin'] },
  lock: { from: 'approved', to: 'locked', roles: ['owner', 'admin'] },
  unlock: { from: 'locked', to: 'approved', roles: ['owner'] },
};

export function isVersionAction(a: unknown): a is VersionAction {
  return a === 'approve' || a === 'lock' || a === 'unlock';
}

export async function transitionVersion(
  companyId: string,
  versionId: string,
  input: { action: VersionAction; reason?: unknown; expectedUpdatedAt?: string },
  actor: VersionActor,
): Promise<BudgetVersion> {
  const move = MOVES[input.action];
  // Existence first: another tenant's id is a 404 for every role, never a 403.
  await getVersion(companyId, versionId);
  if (!move.roles.includes(actor.role)) {
    throw new BudgetVersionError('BUDGET_VERSION_FORBIDDEN',
      input.action === 'unlock' ? 'Only an owner can unlock a budget version' : `Only an owner or admin can ${input.action} a budget version`);
  }
  let reason: string | null = null;
  if (input.action === 'unlock') {
    reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '' || reason.length > 500) {
      throw new BudgetVersionError('BUDGET_VERSION_INPUT', 'An unlock needs a reason (1-500 characters)');
    }
  }
  const expected = input.expectedUpdatedAt ?? null;
  const stamp = actor.userId;
  const rows = (await withRowLockBudget(
    () => sql`
      UPDATE budget_versions SET
        status = ${move.to},
        approved_by = CASE WHEN ${input.action} = 'approve' THEN ${stamp} ELSE approved_by END,
        approved_at = CASE WHEN ${input.action} = 'approve' THEN clock_timestamp() ELSE approved_at END,
        locked_by = CASE WHEN ${input.action} = 'lock' THEN ${stamp} ELSE locked_by END,
        locked_at = CASE WHEN ${input.action} = 'lock' THEN clock_timestamp() ELSE locked_at END,
        unlocked_by = CASE WHEN ${input.action} = 'unlock' THEN ${stamp} ELSE unlocked_by END,
        unlocked_at = CASE WHEN ${input.action} = 'unlock' THEN clock_timestamp() ELSE unlocked_at END,
        unlock_reason = CASE WHEN ${input.action} = 'unlock' THEN ${reason} ELSE unlock_reason END
      WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID AND status = ${move.from}
        AND (${expected}::TIMESTAMPTZ IS NULL OR updated_at = ${expected}::TIMESTAMPTZ)
      RETURNING id
    `,
    () => new RowLockTimeoutError('This budget version'),
  )) as DbRow[];
  if (rows[0]) return getVersion(companyId, versionId);

  const now = await getVersion(companyId, versionId);
  if (now.status !== move.from) {
    throw new BudgetVersionError('BUDGET_VERSION_STATE', `This budget version is ${now.status}; it cannot be ${input.action === 'approve' ? 'approved' : `${input.action}ed`}`);
  }
  // Same status, so only the updated_at predicate can have missed.
  throw new BudgetVersionError('BUDGET_VERSION_STALE', 'This budget version changed since you loaded it; reload and try again');
}
