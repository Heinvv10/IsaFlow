/** The routes' shared answer for a ConnectionRefusal: its status, its plain sentence. */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { ConnectionRefusal } from './connectionTypes';

/** True (and the response sent) when `err` is a refusal; otherwise false so the caller rethrows. */
export function respondIfRefusal(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ConnectionRefusal)) return false;
  if (err.status === 404) apiResponse.notFound(res, 'Connection');
  else if (err.status === 403) apiResponse.forbidden(res, err.message);
  else if (err.status === 409) apiResponse.conflict(res, err.message);
  else apiResponse.badRequest(res, err.message);
  return true;
}
