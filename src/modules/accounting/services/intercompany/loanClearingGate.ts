/**
 * The dark feature flag `intercompany_loan_clearing` (migration 1028): loan-mode clearing of intercompany payments, per company. Off (the
 * default for every company: is_global false, in no plan), the PAYER sends no `allocation` message (allocationOutbox.ts) and the RECEIVER
 * cannot accept one (allocationClearService.ts, the accept route; the inbox shows no Accept). It does not touch the P2 invoice / credit-note
 * mirror, any other outbox kind, or Reject / Dismiss / Restore. A platform admin turns it on for a company with a company_feature_overrides
 * row (the admin features page).
 *
 * ONE flag read per call (`hasFeature`: the override first, then is_global, then the plan), in a savepoint of its own so a read that fails
 * cannot poison the caller's transaction (a payment, an accept). FAIL CLOSED: an error answers false, logged by SQLSTATE only.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { ConnectionRefusal } from './connectionTypes';

export const LOAN_CLEARING_FEATURE = 'intercompany_loan_clearing';

/** What the accept route answers (403) when the receiving company does not have the flag. */
export const LOAN_CLEARING_OFF = 'Clearing intercompany payments against the loan account is not enabled for this company.';

/** The refusal of an accept with the flag off: a 403 (the routes answer it as any ConnectionRefusal), code `not_enabled`, nothing written. */
export class LoanClearingNotEnabled extends ConnectionRefusal {
  readonly code = 'not_enabled' as const;
  constructor() {
    super(403, LOAN_CLEARING_OFF);
    this.name = 'LoanClearingNotEnabled';
  }
}

const sqlstate = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

/** The flag as read: 'on', 'off', or 'unknown' when it could not be read (logged by SQLSTATE only). Never throws. Fix round 1 D: the shared
 *  payment guard tells a failed read from a clean off (it refuses on 'unknown'); every other caller asks `loanClearingEnabled`. */
export type LoanClearingState = 'on' | 'off' | 'unknown';

export async function loanClearingState(companyId: string): Promise<LoanClearingState> {
  try {
    return (await withSavepoint('ic_loan_clearing_flag', () => hasFeature(companyId, LOAN_CLEARING_FEATURE))) === true ? 'on' : 'off';
  } catch (err) {
    // the code, not the database's text (which can name ids)
    log.warn('Intercompany loan clearing flag could not be read: senders and accepts treat it as off, the payment guard refuses', {
      companyId, code: sqlstate(err),
    }, 'intercompany');
    return 'unknown';
  }
}

/** Whether `companyId` has loan clearing. Never throws: a failed read is false (fail closed for a sender, an accept, E). */
export async function loanClearingEnabled(companyId: string): Promise<boolean> {
  return (await loanClearingState(companyId)) === 'on';
}
