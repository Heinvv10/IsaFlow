/**
 * Closing a fiscal period WITH the readiness checks in front of it, for a
 * caller that is not a person (MCP close_fiscal_period): a dry run, and a
 * result that carries the whole checklist.
 *
 * ── THE GATE ITSELF LIVES IN `periodCloseGate.ts` ───────────────────────────
 *
 * This service used to be the only close that refused on the readiness
 * checks; the app's Close was advisory. Since 2026-11-15 (Hein) every close
 * refuses: `closePeriod` runs `assertPeriodCloseReady` under the period row
 * lock, and the blocker rule (`isCloseBlocker`) and the refusal
 * (`PeriodCloseBlockedError`) are shared from `periodCloseErrors.ts`. The
 * pre-flight here answers the dry run and the checklist; the live write is
 * `closePeriod`, which judges the period again under its lock, so a check that
 * went stale in between still refuses.
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
 * reason, so one broken check cannot blank the panel. For a close that is not
 * enough: "the AP tie could not be computed" is exactly the state in which
 * closing is unsafe (`isCloseBlocker`).
 */

import { log } from '@/lib/logger';
import { closePeriod, getFiscalPeriodById } from './fiscalPeriodService';
import {
  getCloseReadiness,
  type ChecklistItem,
} from './periodCloseReadinessService';
import { isCloseBlocker, PeriodCloseBlockedError } from './periodCloseErrors';
import type { FiscalPeriod } from '../../types/gl.types';

export { PeriodCloseBlockedError };

/** The period cannot be closed at all: it is missing, locked, or already closed. */
export class PeriodNotCloseableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodNotCloseableError';
  }
}

export interface ClosePeriodOptions {
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

export async function closePeriodWithReadiness(
  companyId: string,
  periodId: string,
  userId: string,
  options: ClosePeriodOptions,
): Promise<ClosePeriodResult> {
  const dryRun = options.dryRun === true;

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

  const blockers = readiness.items.filter(isCloseBlocker);
  if (blockers.length > 0) {
    // Thrown BEFORE `closePeriod` runs, so nothing is written on either path
    // and the dry run refuses exactly where the live call would.
    throw new PeriodCloseBlockedError(readiness.periodLabel, blockers, readiness.items, periodId);
  }

  const warnings = readiness.items.filter((i) => i.status !== 'pass');

  if (dryRun) {
    return { period, closed: false, dryRun: true, checklist: readiness.items, warnings };
  }

  // closePeriod runs the shared gate again under the period row lock: that verdict is the one that counts.
  const closedPeriod = await closePeriod(companyId, periodId, userId);
  log.info('Fiscal period closed after readiness checks', {
    companyId, periodId, warnings: warnings.length,
  }, 'accounting');

  return { period: closedPeriod, closed: true, dryRun: false, checklist: readiness.items, warnings };
}
