/** The loan reconciliation routes' shared answer for a refusal (P5): its status, its fixed sentence and its code. */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { ReconRefusal } from './loanReconRefusals';

const CODE: Record<ReconRefusal['status'], ErrorCode> = {
  403: ErrorCode.FORBIDDEN, 404: ErrorCode.NOT_FOUND, 422: ErrorCode.BUSINESS_RULE_VIOLATION, 503: ErrorCode.SERVICE_UNAVAILABLE,
};

/** True (and the response sent) when `err` is a refusal; otherwise false so the caller rethrows. */
export function respondIfReconRefusal(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ReconRefusal)) return false;
  apiResponse.error(res, CODE[err.status], err.message, { reason: err.code });
  return true;
}
