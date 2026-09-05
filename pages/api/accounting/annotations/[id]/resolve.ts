/**
 * POST — marks one annotation resolved under the authenticated caller.
 *
 * Resolving twice is not idempotent on purpose: a second call finds no open
 * row and answers 404 rather than rewriting resolved_by, so the audit trail
 * names the person who actually settled the note.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { resolveAnnotation } from '@/modules/accounting/services/annotations/annotationService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.notFound(res, 'Annotation');

  // A row belonging to another company answers the same 404 as one that does
  // not exist, and as one already resolved: no probe distinguishes them.
  if (!(await resolveAnnotation(companyId, id, user.id))) return apiResponse.notFound(res, 'Annotation');
  return apiResponse.success(res, { resolved: true });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
