/**
 * Budget versions (migration 947): the shape the services and routes return, and the one typed
 * error every version-aware budget path throws. Database refusals reach callers only through
 * `mapBudgetDbError`, so a route answers the contract codes (spec §6) and any other database
 * error stays a 500.
 */
import type { DbRow } from '@/lib/neon';

export type BudgetVersionKind = 'original' | 'reforecast' | 'scenario';
export type BudgetVersionStatus = 'draft' | 'approved' | 'locked';

export const BUDGET_VERSION_KINDS: readonly BudgetVersionKind[] = ['original', 'reforecast', 'scenario'];

export interface BudgetVersion {
  id: string;
  fiscalYear: number;
  name: string;
  kind: BudgetVersionKind;
  status: BudgetVersionStatus;
  basedOnVersionId: string | null;
  isPrimary: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  unlockedBy: string | null;
  unlockedAt: string | null;
  unlockReason: string | null;
  createdBy: string;
  createdAt: string;
  /** Text with microseconds: the CAS token `expectedUpdatedAt` compares against. */
  updatedAt: string;
  /** Amount rows in the version, and their sum. */
  amountCount: number;
  total: number;
}

export type BudgetVersionErrorCode =
  | 'BUDGET_VERSION_LOCKED'
  | 'BUDGET_VERSION_STALE'
  | 'BUDGET_VERSION_STATE'
  | 'BUDGET_VERSION_FORBIDDEN'
  | 'BUDGET_VERSION_NOT_FOUND'
  | 'BUDGET_GRAIN_CONFLICT'
  | 'BUDGET_VERSION_INPUT';

const STATUS_OF: Record<BudgetVersionErrorCode, 400 | 403 | 404 | 409> = {
  BUDGET_VERSION_LOCKED: 409,
  BUDGET_VERSION_STALE: 409,
  BUDGET_VERSION_STATE: 409,
  BUDGET_VERSION_FORBIDDEN: 403,
  BUDGET_VERSION_NOT_FOUND: 404,
  BUDGET_GRAIN_CONFLICT: 400,
  BUDGET_VERSION_INPUT: 400,
};

/** A refusal whose message is safe to show the caller; `status` is the HTTP answer. */
export class BudgetVersionError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(readonly code: BudgetVersionErrorCode, message: string) {
    super(message);
    this.name = 'BudgetVersionError';
    this.status = STATUS_OF[code];
  }
}

/**
 * A database refusal of migration 947 as a BudgetVersionError (BV001 locked, BV002 an illegal
 * move, 23P01 on budget_month_amounts_one_grain a grain clash), or null for any other error.
 * The services refuse these before writing; this maps the trigger/constraint backstop (a race
 * past the service check) onto the same contract codes instead of a 500.
 */
export function budgetDbRefusal(err: unknown): BudgetVersionError | null {
  const e = err as { code?: string; constraint?: string } | null;
  if (e?.code === 'BV001') return new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked');
  if (e?.code === 'BV002') return new BudgetVersionError('BUDGET_VERSION_STATE', 'That change is not allowed for this budget version');
  if (e?.code === '23P01' && e.constraint === 'budget_month_amounts_one_grain') {
    return new BudgetVersionError('BUDGET_GRAIN_CONFLICT', 'An account is budgeted at one level per version: company level or one dimension');
  }
  return null;
}

/** `budgetDbRefusal`, thrown; anything else is rethrown as is. */
export function mapBudgetDbError(err: unknown): never {
  throw budgetDbRefusal(err) ?? err;
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The SELECT list every version read uses (`v` = budget_versions), so mapVersion sees one shape. */
export function mapVersion(r: DbRow): BudgetVersion {
  return {
    id: String(r.id),
    fiscalYear: Number(r.fiscal_year),
    name: String(r.name),
    kind: String(r.kind) as BudgetVersionKind,
    status: String(r.status) as BudgetVersionStatus,
    basedOnVersionId: text(r.based_on_version_id),
    isPrimary: Boolean(r.is_primary),
    approvedBy: text(r.approved_by),
    approvedAt: text(r.approved_at_text),
    lockedBy: text(r.locked_by),
    lockedAt: text(r.locked_at_text),
    unlockedBy: text(r.unlocked_by),
    unlockedAt: text(r.unlocked_at_text),
    unlockReason: text(r.unlock_reason),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at_text),
    updatedAt: String(r.updated_at_text),
    amountCount: Number(r.amount_count ?? 0),
    total: Number(r.total ?? 0),
  };
}
