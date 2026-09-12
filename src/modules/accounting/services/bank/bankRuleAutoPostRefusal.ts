/**
 * What the controlled bank allocation may refuse a rule line for, and the one
 * place that decides whether an error thrown at it is such a refusal or a fault.
 *
 * The contract the sweep holds: inside its per-line savepoint, EVERY refusal
 * the controlled path can raise becomes a per-line outcome and the run
 * continues — a refusal is a fact about this line's business state, and the
 * savepoint has already unwound whatever the line wrote. A genuine fault — a
 * pg error, or an integrity failure that has already poisoned the request's
 * control transaction — still aborts the run: continuing past one would
 * report a partial commit as a success, or a 500 as a count.
 */

import { als } from '@/lib/als';
import { EffectivePermissionError } from '@/lib/auth/effectivePermissionQueries';
import { isSuppliedApprovalRefusal, OperationApprovalRequiredError } from '../controls/approvalExecutionService';
import { BeneficiaryError } from '../controls/beneficiaryValidation';
import { ClosedFiscalPeriodError, LOCKDOWN_REFUSAL_MESSAGE, VAT_PERIOD_REFUSAL_MESSAGE } from '../gl/postingPeriodGuard';

export type AutoPostRefusal =
  /** The company's approval policy binds an allocation of this amount; a person requests the approval from the screen. */
  | { kind: 'approval_required' }
  /** The supplier has no verified beneficiary (or a pending hold / changed banking); verify it, then re-run. */
  | { kind: 'beneficiary_unverified'; reason: string }
  /** Its date falls in a closed/locked fiscal period - re-open the period to post it. */
  | { kind: 'closed_period' }
  /** Its date is on or before the company lockdown date. */
  | { kind: 'lockdown' }
  /** The line would claim or declare VAT in a period whose return has been filed. */
  | { kind: 'vat_period_filed' }
  /** The running person lacks the permission the allocation asserts (write:bank-tx / write:post). */
  | { kind: 'permission_denied'; reason: string }
  /** Any other business refusal of the controlled path, with the kernel's own reason. */
  | { kind: 'refused'; reason: string };

/**
 * A pg error carries a five-character SQLSTATE in `code`; the control
 * functions' deliberate RAISEs (P0001, 42501) are marked by the kernel as a
 * supplied-approval refusal before they reach here and are handled above.
 */
function isTransportFault(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * The per-line outcome for an error the controlled allocation threw, or null
 * when the error is a fault the sweep must let escape.
 */
export function classifyAutoPostRefusal(error: unknown): AutoPostRefusal | null {
  // A refusal that fired INSIDE the controlled write has already poisoned the
  // request — withAuth will answer 500 whatever this sweep reports — so it is a
  // fault here, not a count. The pre-write checks exist so this does not happen.
  if (als.getStore()?.controlWriteFailed) return null;
  if (error instanceof OperationApprovalRequiredError) return { kind: 'approval_required' };
  if (error instanceof BeneficiaryError) return { kind: 'beneficiary_unverified', reason: error.code };
  if (error instanceof ClosedFiscalPeriodError) return { kind: 'closed_period' };
  if (error instanceof EffectivePermissionError) return { kind: 'permission_denied', reason: error.message };
  if (!(error instanceof Error)) return null;
  if (error.message === LOCKDOWN_REFUSAL_MESSAGE) return { kind: 'lockdown' };
  if (error.message === VAT_PERIOD_REFUSAL_MESSAGE) return { kind: 'vat_period_filed' };
  if (isSuppliedApprovalRefusal(error)) return { kind: 'refused', reason: error.message };
  if (isTransportFault(error)) return null;
  return { kind: 'refused', reason: error.message };
}
