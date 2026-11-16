/**
 * The wire shape of a refused period close: the `error.details` of the 409 the
 * close, Bulk Close, Close Year, Lock and year-end paths answer with.
 *
 * No runtime imports (types only), so the screens can import it without
 * bundling any server code: `closeRefusal.ts` reads a refusal with this alone.
 */

import type { ChecklistItemKey } from './periodCloseReadinessService';

/** `error.details.code` on the 409 a refused close answers with. */
export const PERIOD_CLOSE_NOT_READY = 'PERIOD_CLOSE_NOT_READY';

/** One failing check, as the screen shows it: what, why, and where to fix it. */
export interface CloseBlocker {
  key: ChecklistItemKey;
  label: string;
  reason: string;
  fixHref: string;
}

export interface BlockedPeriod {
  periodId: string;
  periodName: string;
  blockers: CloseBlocker[];
}

export interface CloseRefusalDetails {
  code: typeof PERIOD_CLOSE_NOT_READY;
  /** Set when a whole year was refused (Close Year, year-end close). */
  fiscalYear?: number;
  periods: BlockedPeriod[];
}
