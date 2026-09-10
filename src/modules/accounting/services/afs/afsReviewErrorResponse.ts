// src/modules/accounting/services/afs/afsReviewErrorResponse.ts
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { ReviewError } from './afsReviewError';

/**
 * One mapping for every AFS route that writes a section or moves a document: a section reached
 * through the wrong document is 404, a locked document or a contended row is 409, and an
 * impersonated session is 403 — never the 500 an unmapped throw would produce.
 *
 * Returns false when the error is not a ReviewError, so the caller rethrows it.
 */
export function sendReviewError(res: NextApiResponse, err: unknown, entity = 'AFS section', id?: string): boolean {
  if (!(err instanceof ReviewError)) return false;
  if (err.code === 'NOT_FOUND') apiResponse.notFound(res, entity, id);
  else if (err.code === 'IMPERSONATED') apiResponse.forbidden(res, err.message);
  else apiResponse.error(res, ErrorCode.CONFLICT, err.message);
  return true;
}
