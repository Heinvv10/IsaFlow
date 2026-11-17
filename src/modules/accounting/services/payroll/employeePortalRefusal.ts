/**
 * An employee-portal invite, revoke or sign-in refused before any write or send (wave 6 SS, spec rule 12). The route
 * answers it with `status` and `details.reason`.
 */
export type EmployeePortalRefusalReason =
  | 'FEATURE_DISABLED' | 'PORTAL_OFF' | 'NOT_FOUND' | 'NO_EMAIL' | 'ACCESS_ENDED' | 'ALREADY_ACTIVE' | 'NO_ACCESS'
  | 'RATE_LIMITED' | 'INVITE_INVALID' | 'WEAK_PASSWORD';

const STATUS: Record<EmployeePortalRefusalReason, 400 | 403 | 404 | 409 | 429> = {
  FEATURE_DISABLED: 403, PORTAL_OFF: 403, NOT_FOUND: 404, NO_EMAIL: 409, ACCESS_ENDED: 403, ALREADY_ACTIVE: 409,
  NO_ACCESS: 409, RATE_LIMITED: 429, INVITE_INVALID: 400, WEAK_PASSWORD: 400,
};

export class EmployeePortalRefusal extends Error {
  readonly code = 'EMPLOYEE_PORTAL_REFUSED';
  readonly status: 400 | 403 | 404 | 409 | 429;
  constructor(readonly reason: EmployeePortalRefusalReason, message: string) {
    super(message);
    this.name = 'EmployeePortalRefusal';
    this.status = STATUS[reason];
  }
}
