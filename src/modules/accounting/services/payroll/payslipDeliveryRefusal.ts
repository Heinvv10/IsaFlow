/**
 * A payslip email refused before anything is sent or written (wave 6 PE, spec rule 12). The route answers it with
 * `status` and `details.reason`.
 */
export type PayslipEmailRefusalReason =
  | 'FEATURE_DISABLED' | 'SETTING_OFF' | 'NOT_FOUND' | 'NOT_FINAL' | 'DETAILS_NOT_FROZEN' | 'RATE_LIMITED';

const STATUS: Record<PayslipEmailRefusalReason, 403 | 404 | 409 | 429> = {
  FEATURE_DISABLED: 403, SETTING_OFF: 409, NOT_FOUND: 404, NOT_FINAL: 409, DETAILS_NOT_FROZEN: 409, RATE_LIMITED: 429,
};

export class PayslipEmailRefusal extends Error {
  readonly code = 'PAYSLIP_EMAIL_REFUSED';
  readonly status: 403 | 404 | 409 | 429;
  constructor(readonly reason: PayslipEmailRefusalReason, message: string) {
    super(message);
    this.name = 'PayslipEmailRefusal';
    this.status = STATUS[reason];
  }
}
