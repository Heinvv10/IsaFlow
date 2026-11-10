import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import type { ReturnRefusal } from './returnVersionTypes';

/** A ReturnRefusal as its HTTP answer. */
export function respondReturnRefusal(res: NextApiResponse, err: ReturnRefusal): void {
  if (err.status === 409) return void apiResponse.conflict(res, err.message, err.refusalCode ? { code: err.refusalCode } : undefined);
  if (err.status === 403) return void apiResponse.forbidden(res, err.message);
  if (err.status === 404) return void apiResponse.notFound(res, 'Return version');
  return void apiResponse.badRequest(res, err.message);
}
