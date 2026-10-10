/**
 * The HTTP answer to a bank-control refusal (forensic-controls step 2): the
 * refusal's own status (403 who may not, 404 nothing there, 409 state moved)
 * with its reason code. Every refusal is raised before any write, so the
 * COMMIT withAuth issues on a 4xx commits nothing of the refused act.
 * Returns true when it answered, for a route's catch to `return` on.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { BankControlError } from './bankControlRefusal';

const CODE = { 403: ErrorCode.FORBIDDEN, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT } as const;

export function respondIfBankControlRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof BankControlError)) return false;
  apiResponse.error(res, CODE[err.status], err.message, { reason: err.code });
  return true;
}
