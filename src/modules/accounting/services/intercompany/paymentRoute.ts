/** The payment routes' shared answer for a refusal (intercompany F): a PaymentRefusal's status and sentence (422 a business-rule refusal), else the connection refusal's. */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { respondIfRefusal } from './connectionRoute';
import { PaymentRefusal } from './paymentAcceptRules';

/** True (and the response sent) when `err` is a refusal; otherwise false so the caller rethrows. */
export function respondIfPaymentRefusal(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof PaymentRefusal) {
    if (err.status === 404) apiResponse.notFound(res, 'Message');
    else if (err.status === 403) apiResponse.forbidden(res, err.message);
    else if (err.status === 409) apiResponse.conflict(res, err.message);
    else apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION, err.message, { reason: err.code });
    return true;
  }
  return respondIfRefusal(res, err);
}
