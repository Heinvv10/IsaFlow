/**
 * The HTTP answer for a refusal of the Budget vs Actual tracking engine
 * (budgets P3 spec §4): `TrackingError` with its own status (400 a bad window
 * or a version from another year, 404 an id that is not this company's, 409 a
 * registry year that is not whole calendar months), a budget-version refusal
 * through `respondBudgetVersionError`, and an unknown financial-year label as
 * a 404. Anything else is not answered here: the route rethrows it and
 * withErrorHandler answers 500.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';

const CODE_FOR_STATUS = {
  400: ErrorCode.BAD_REQUEST,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
} as const;

/** True when `err` was answered. */
export function respondTrackingError(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof TrackingError) {
    apiResponse.error(res, CODE_FOR_STATUS[err.status], err.message);
    return true;
  }
  if (err instanceof FiscalYearLabelUnknownError) {
    apiResponse.error(res, ErrorCode.NOT_FOUND, `No financial year is labelled ${err.fiscalYear}`);
    return true;
  }
  return respondBudgetVersionError(res, err);
}
