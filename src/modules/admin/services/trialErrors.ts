/**
 * Refusals of the admin trial actions. Raised before anything is written, so a
 * route can answer 4xx for them and commit nothing. Kept apart from trialService
 * so a route can test `instanceof` without depending on the service module.
 */

export type TrialConvertErrorCode =
  | 'company_not_found' | 'company_not_convertible' | 'plan_not_found' | 'plan_not_convertible'
  | 'already_paid' | 'subscription_paused';

export class TrialConvertError extends Error {
  constructor(readonly code: TrialConvertErrorCode, message: string) {
    super(message);
    this.name = 'TrialConvertError';
  }
}

export type TrialExtendErrorCode = 'company_not_found' | 'already_paid';

export class TrialExtendError extends Error {
  constructor(readonly code: TrialExtendErrorCode, message: string) {
    super(message);
    this.name = 'TrialExtendError';
  }
}
