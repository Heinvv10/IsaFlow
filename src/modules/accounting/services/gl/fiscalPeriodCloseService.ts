/**
 * Closing a fiscal period WITH the readiness checks in front of it.
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 *
 * `closePeriod` refuses a locked period, an already-closed one, and one with
 * open priors — and then closes over unreconciled banks, draft journals, an
 * out-of-balance trial balance and a subledger that does not tie. The checks
 * exist (`periodCloseReadinessService`) and the Month-End Workbench shows them
 * to a person, who may reasonably decide to close anyway. Nothing carried them
 * to a caller that is not a person.
 *
 * ── WHY THIS COMPOSES RATHER THAN WIDENING `closePeriod` ────────────────────
 *
 * The UI's advisory close works and people rely on it; turning that screen into
 * one that refuses is a product decision, not this programme's. So the two
 * existing services are composed into a third that MCP calls, and neither is
 * forked: the checks are still `getCloseReadiness`'s and the write is still
 * `closePeriod`'s.
 *
 * ── WHY A LIST AND NOT A BOOLEAN ────────────────────────────────────────────
 *
 * "Not ready" is not a lock an agent can respect. It cannot tell whether to
 * reconcile a bank, post three drafts, or stop and ask a human. Every failing
 * check comes back with its key, its reason and the screen that fixes it.
 *
 * ── A CHECK THAT COULD NOT RUN IS A BLOCKER ─────────────────────────────────
 *
 * `getCloseReadiness` degrades a check that threw to `warn` with a fixed
 * reason, so one broken check cannot blank the panel. For a person reading a
 * screen that is right. For a caller closing a period unattended it is not:
 * "the AP tie could not be computed" is exactly the state in which closing is
 * unsafe, and a warning it will ignore is worse than a refusal it must handle.
 */

import { log } from '@/lib/logger';
import { closePeriod, getFiscalPeriodById } from './fiscalPeriodService';
import { assertPeriodControlAuthority } from '../controls/periodControl';
import { controlledOperationApprovalRequiredForPreview } from '../controls/approvalExecutionService';
import { requireControlTx } from '../controls/context';
import {
  getCloseReadiness,
  type ChecklistItem,
} from './periodCloseReadinessService';
import type { FiscalPeriod } from '../../types/gl.types';

/** The exact reason `getCloseReadiness` substitutes for a check that threw. */
const UNCOMPUTED_REASON = 'Could not compute — check the relevant module.';

/** The period cannot be closed at all: it is missing, locked, or already closed. */
export class PeriodNotCloseableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodNotCloseableError';
  }
}

/** The period is closeable in principle and the books are not ready. */
export class PeriodCloseBlockedError extends Error {
  readonly blockers: ChecklistItem[];
  readonly checklist: ChecklistItem[];

  constructor(periodLabel: string, blockers: ChecklistItem[], checklist: ChecklistItem[]) {
    super(
      `${periodLabel} cannot be closed — ${blockers.length} check`
      + `${blockers.length === 1 ? '' : 's'} did not pass: `
      + blockers.map((b) => `${b.key}: ${b.reason}`).join('; '),
    );
    this.name = 'PeriodCloseBlockedError';
    this.blockers = blockers;
    this.checklist = checklist;
  }
}

export interface ClosePeriodOptions {
  approvalId?: string;
  /** Run every guard and report, but do not write. */
  dryRun?: boolean;
}

export interface ClosePeriodResult {
  period: FiscalPeriod;
  /** False on a dry run, and on nothing else — a refusal throws. */
  closed: boolean;
  dryRun: boolean;
  /** Every check that ran, passes included. */
  checklist: ChecklistItem[];
  /** Checks that did not pass but did not block. */
  warnings: ChecklistItem[];
}

/** A `warn` that means "this check did not run" blocks; an ordinary warn does not. */
function isBlocker(item: ChecklistItem): boolean {
  return item.status === 'fail' || (item.status === 'warn' && item.reason === UNCOMPUTED_REASON);
}

export async function closePeriodWithReadiness(
  companyId: string,
  periodId: string,
  userId: string,
  options: ClosePeriodOptions,
): Promise<ClosePeriodResult> {
  const dryRun = options.dryRun === true;
  // The preview answers about a close, so it runs the close's own authority.
  // Only the write itself is skipped.
  await assertPeriodControlAuthority(companyId, userId);

  // Ownership first, and the miss is generic: a distinct "belongs to another
  // company" reply would be an existence oracle.
  const period = await getFiscalPeriodById(companyId, periodId);
  if (!period) throw new PeriodNotCloseableError('Not found');
  if (period.status === 'locked') {
    throw new PeriodNotCloseableError(`${period.periodName} is locked and cannot be closed`);
  }
  if (period.status === 'closed') {
    throw new PeriodNotCloseableError(`${period.periodName} is already closed`);
  }

  const readiness = await getCloseReadiness(companyId, periodId);
  if (!readiness) throw new PeriodNotCloseableError('Not found');

  const blockers = readiness.items.filter(isBlocker);
  if (blockers.length > 0) {
    // Thrown BEFORE `closePeriod` runs, so nothing is written on either path
    // and the dry run refuses exactly where the live call would.
    throw new PeriodCloseBlockedError(readiness.periodLabel, blockers, readiness.items);
  }

  const warnings = readiness.items.filter((i) => i.status !== 'pass');

  if (dryRun) {
    // The live close runs through the period control, which refuses under a
    // fiscal_period approval policy; the preview asks the same question.
    const answer = await controlledOperationApprovalRequiredForPreview(requireControlTx(),
      { entityType: 'fiscal_period', entityId: periodId, operation: 'fiscal_period.close' });
    if (answer.kind === 'answered' && answer.required) {
      throw new PeriodNotCloseableError(`An independent approval is required to close ${period.periodName}. `
        + 'Request one with request_operation_approval, then retry. Nothing was closed');
    }
    if (answer.kind === 'unavailable' && answer.policiesExist) {
      throw new PeriodNotCloseableError(`${period.periodName} could not be previewed — its close material `
        + 'could not be built; an approval may also be required. Nothing was closed');
    }
    return { period, closed: false, dryRun: true, checklist: readiness.items, warnings };
  }

  const closedPeriod = options.approvalId
    ? await closePeriod(companyId, periodId, userId, { approvalId: options.approvalId })
    : await closePeriod(companyId, periodId, userId);
  log.info('Fiscal period closed after readiness checks', {
    companyId, periodId, warnings: warnings.length,
  }, 'accounting');

  return { period: closedPeriod, closed: true, dryRun: false, checklist: readiness.items, warnings };
}
