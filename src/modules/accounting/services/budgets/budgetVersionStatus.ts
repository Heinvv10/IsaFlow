/**
 * Approve, lock and unlock a budget version (decisions 1, 2 and 11). Approve and lock: owner or
 * admin. Unlock: owner only, with a reason (1-500 characters). Each move is a compare-and-set on the
 * status the move starts from, and optionally on `expectedUpdatedAt` (the client's last read), so of
 * two concurrent moves one wins and the other is a 409. The audit row is written by the database
 * (budget_versions_audit, migration 947), never here, so no path can move a version unaudited.
 *
 * Budget holders (P5-6, decision 9a): approve is refused (409 BUDGET_SLICES_PENDING) while any of
 * the version's slice reviews is not 'approved', unless the OWNER forces it with a reason (1-500
 * characters), which adds one audit row naming the reason and the slices still pending. The
 * version row is taken FOR NO KEY UPDATE before the slices are read: a slice move holds the version
 * FOR SHARE (sliceReviewState), so a move in flight finishes first and is seen, or waits and then
 * finds the version approved. Self-approval is allowed: an owner or admin may approve slices and then
 * the version themselves (each move is audited). Migration 955's budget_versions_slice_gate holds the
 * same rule in the database (owner/admin session; the owner's force through budget_version_force_begin).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { logAuditOrThrow } from '../core/auditTrailService';
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
  input: { action: VersionAction; reason?: unknown; expectedUpdatedAt?: string; force?: boolean },
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
  const forced = input.action === 'approve' ? await assertSlicesApproved(companyId, versionId, input, actor) : null;
  // The owner's force is the database's to accept too (955 budget_versions_slice_gate re-checks the role).
  if (forced) await sql`SELECT public.budget_version_force_begin(${companyId}::UUID, ${versionId}::UUID)`;
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
  if (rows[0]) {
    if (forced) {
      await logAuditOrThrow({
        companyId, userId: actor.userId, action: 'approve', entityType: 'budget', entityId: versionId, entityRef: 'Budget version approved over open slices',
        changes: { fields: [], metadata: { forcedApproval: 'true', reason: forced.reason, pendingSlices: String(forced.pending.length), slices: capped(forced.pending) } },
      });
    }
    return getVersion(companyId, versionId);
  }

  const now = await getVersion(companyId, versionId);
  if (now.status !== move.from) {
    throw new BudgetVersionError('BUDGET_VERSION_STATE', `This budget version is ${now.status}; it cannot be ${input.action === 'approve' ? 'approved' : `${input.action}ed`}`);
  }
  // Same status, so only the updated_at predicate can have missed.
  throw new BudgetVersionError('BUDGET_VERSION_STALE', 'This budget version changed since you loaded it; reload and try again');
}

/** At most 40 slices named in an audit row (as the roll's unplacedSummary), then "+N more". */
export function capped(list: readonly string[], max = 40): string {
  return list.length > max ? `${list.slice(0, max).join('; ')}; +${list.length - max} more` : list.join('; ');
}

/**
 * Decision 9a: every assigned slice approved, or the owner forcing it with a reason. Takes the version
 * row first (FOR NO KEY UPDATE, bounded), then reads the slices in a new statement, so a slice move
 * committed while it waited is seen. Returns the force (reason and the pending slices) or null.
 */
async function assertSlicesApproved(
  companyId: string, versionId: string, input: { reason?: unknown; force?: boolean }, actor: VersionActor,
): Promise<{ reason: string; pending: string[] } | null> {
  await withRowLockBudget(
    () => sql`SELECT 1 FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID FOR NO KEY UPDATE`,
    () => new RowLockTimeoutError('This budget version'),
  );
  const rows = (await sql`
    SELECT r.status, CASE WHEN r.cc1_id IS NOT NULL THEN 'CC1 ' || COALESCE(c.code, r.cc1_id::TEXT)
                          WHEN r.cc2_id IS NOT NULL THEN 'CC2 ' || COALESCE(c.code, r.cc2_id::TEXT)
                          WHEN r.bu_id IS NOT NULL THEN 'BU ' || COALESCE(b.code, r.bu_id::TEXT) ELSE 'Company level' END AS label
      FROM budget_slice_reviews r
      LEFT JOIN cost_centres c ON c.id = COALESCE(r.cc1_id, r.cc2_id) AND c.company_id = r.company_id
      LEFT JOIN business_units b ON b.id = r.bu_id AND b.company_id = r.company_id
     WHERE r.company_id = ${companyId}::UUID AND r.version_id = ${versionId}::UUID AND r.status <> 'approved'
     ORDER BY 2
  `) as DbRow[];
  if (rows.length === 0) return null;
  const pending = rows.map((r) => `${String(r.label)} (${String(r.status)})`);
  if (input.force !== true) {
    throw new BudgetVersionError('BUDGET_SLICES_PENDING',
      `${rows.length} budget slice${rows.length === 1 ? ' is' : 's are'} not approved yet: ${pending.slice(0, 5).join(', ')}${rows.length > 5 ? ', …' : ''}. Approve them, or (owner) approve anyway with a reason`);
  }
  if (actor.role !== 'owner') throw new BudgetVersionError('BUDGET_VERSION_FORBIDDEN', 'Only an owner can approve a budget version over slices that are not approved');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '' || reason.length > 500) {
    throw new BudgetVersionError('BUDGET_VERSION_INPUT', 'Approving over slices that are not approved needs a reason (1-500 characters)');
  }
  return { reason, pending };
}
