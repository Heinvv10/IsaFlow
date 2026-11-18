/**
 * Wave 6 HYb (coordinator ruling, option a): a pay run that R-035 approval governs may not be prepared by a user whose
 * id is not UUID-shaped, until wave 7 makes approval_requests' actor columns TEXT.
 *
 * After 999w `payroll_run_headers.prepared_by` is TEXT and takes any user id, but approval_document_authors still
 * returns uuid[] (it casts the preparer) and approval_request_decide casts its decider to uuid. A run prepared by such a
 * user would leave every approve, reject, withdraw and re-raise of its approval request failing with 22P02. So the
 * calculation, the one writer of `prepared_by` (payrollRunLock#saveCalculatedRunTotals), refuses that user first, with
 * a 409 raised before any write. Where no active pay_run approval rule exists, nothing is raised for approval, and such
 * a preparer keeps working (HYa's intent). Any active rule counts, whatever its condition and whether or not
 * enforcement is on: a request can be raised against it, so this fails closed.
 */
import { sql } from '@/lib/neon';
import { PayrollRunInputRefusedError } from './payrollRunInputRefused';

/** Ids Postgres reads as uuid: 32 hex digits, hyphens optional at the canonical places. A subset of what uuid_in takes. */
const UUID_SHAPED = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export const PREPARER_ID_NOT_SUPPORTED_MESSAGE = "This account can't prepare pay runs that need approval yet.";

export class PreparerIdNotSupportedError extends PayrollRunInputRefusedError {
  readonly code = 'PREPARER_ID_NOT_SUPPORTED';
  constructor() {
    super(409, PREPARER_ID_NOT_SUPPORTED_MESSAGE);
    this.name = 'PreparerIdNotSupportedError';
  }
}

/** Throws PreparerIdNotSupportedError when `preparer` is not UUID-shaped and an active pay_run rule exists. */
export async function assertPreparerSupported(companyId: string, preparer: string | null): Promise<void> {
  if (preparer == null || UUID_SHAPED.test(preparer)) return;
  const rules = (await sql`
    SELECT 1 FROM approval_rules
    WHERE company_id = ${companyId} AND document_type = 'pay_run' AND is_active = true
    LIMIT 1
  `) as unknown[];
  if (rules.length > 0) throw new PreparerIdNotSupportedError();
}
