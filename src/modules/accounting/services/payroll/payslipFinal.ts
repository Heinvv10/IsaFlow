/**
 * Whether a pay run's payslips are final (wave 4 PS, spec rule 6). ONLY the
 * R-035 finalisation guard decides: `assertPayRunApproved` resolving means final.
 * Never a status string: an `approved` row that R-035 has not cleared (and that
 * migration 951 did not grandfather) is a DRAFT payslip.
 *
 * A refusal of any kind (not approved, no reviewed plan, not cleared, not found)
 * is DRAFT. A database error is not a refusal and is re-thrown, so a failed read
 * is a 500, never a slip that silently says DRAFT for the wrong reason.
 */
import { assertPayRunApproved } from './payRunApprovalControl';

const isDatabaseError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
  && /^[0-9A-Z]{5}$/.test((err as { code: string }).code) && 'severity' in err;

export async function isPayRunFinal(companyId: string, runId: string): Promise<boolean> {
  try {
    await assertPayRunApproved(companyId, runId);
    return true;
  } catch (err) {
    if (isDatabaseError(err)) throw err;
    return false;
  }
}
