/**
 * The frame every driver and planned-hire write runs in (P4 spec §5), inside withAuth's request
 * transaction:
 *
 *   holdYearRegistry (shared; before the registry is read, as every budget writer)
 *   → ONE savepoint: takeVersion (FIRST: the grid save's compare-and-set on the client's
 *     `expectedUpdatedAt`, which is also P1's pre-lock: 404 NOT_FOUND, 409 LOCKED, 409 STALE with
 *     the current token and status, all before anything is written) → the write →
 *     recomputeVersion (per_head rows live as the write says: see driverRecomputeService) → one audit row (entity 'budget', the version) naming the action and the
 *     cells the recompute changed → the version's new token.
 *
 * The savepoint matters: withAuth COMMITs a 4xx, so a refusal raised after a write (a cycle, a
 * grain clash, the lock trigger's BV001) must roll the write and the token bump back with it.
 * Database refusals are mapped by `mapBudgetDbError`; the engine's errors reach the route as they
 * are (`respondBudgetDriverError`, 400 with the code).
 */
import { withSavepoint } from '@/lib/neon';
import { auditBudgetWrite, holdYearRegistry } from '../budgetVersionScope';
import { mapBudgetDbError } from '../budgetVersionTypes';
import { inputError, isVersionToken } from '../gridErrors';
import { takeVersion } from '../versionTake';
import type { RowKey } from './driverTypes';
import { recomputeVersion, versionMonths, type RecomputeWarning } from './driverRecomputeService';

export interface DriverWriteTarget {
  versionId: string;
  /** The version's updatedAt as the client read it (text, microseconds). */
  expectedUpdatedAt: string;
}

export interface DriverWriteContext {
  versionId: string;
  fiscalYear: number;
  months: string[];
}

export interface DriverWriteOutcome {
  /** The version's new token (UTC ISO, microseconds). */
  updatedAt: string;
  /** Cells the recompute changed. */
  recomputed: number;
  warnings: RecomputeWarning[];
}

export interface DriverWriteBody<T> {
  value: T;
  audit?: Record<string, string>;
  /** per_head rows that read headcount in the recompute: 'all', or these rows (default none). */
  live?: 'all' | ReadonlySet<RowKey>;
}

export async function runDriverWrite<T extends object>(
  companyId: string, userId: string, target: DriverWriteTarget, action: string,
  write: (ctx: DriverWriteContext) => Promise<DriverWriteBody<T>>,
): Promise<T & DriverWriteOutcome> {
  const versionId = target.versionId.toLowerCase();
  // Checked here too: one Postgres cannot read would be a 500 at the compare.
  if (!isVersionToken(target.expectedUpdatedAt)) throw inputError('expectedUpdatedAt must be the updatedAt the version was read with');
  await holdYearRegistry(companyId);
  try {
    return await withSavepoint('budget_driver_write', async () => {
      const version = await takeVersion(companyId, versionId, target.expectedUpdatedAt);
      const months = await versionMonths(companyId, version.fiscalYear);
      const { value, audit, live } = await write({ versionId, fiscalYear: version.fiscalYear, months });
      const { changed, warnings } = await recomputeVersion(companyId, versionId, userId, { live });
      await auditBudgetWrite(companyId, userId, 'update', versionId, version.fiscalYear, {
        driverAction: action, ...audit, recomputed: String(changed), versionStatus: version.status,
      });
      return { ...value, updatedAt: version.updatedAt, recomputed: changed, warnings };
    });
  } catch (err) {
    return mapBudgetDbError(err);
  }
}
