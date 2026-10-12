/**
 * Audit comparisons (forensic-controls step 4).
 * GET ?snapshotId=            the snapshot against today's books at its cutoff: backdated, changed (field level),
 *                             removed and reversed-after journals, TB movement, master-data changes since it was taken
 * GET ?snapshotId=&against=   against a later snapshot of the same company (same or later cutoff)
 * Owner / admin / manager. Read-only: nothing is written.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { mayReadAudit, respondAuditRefusal } from '@/modules/accounting/services/audit/auditAccess';
import { principalFromRequest } from '@/modules/accounting/services/audit/auditTx';
import { compareSnapshotToLive, compareSnapshots } from '@/modules/accounting/services/audit/comparisonService';
import { withSnapshotSlot } from '@/modules/accounting/services/audit/snapshotSlots';

const Query = z.object({ snapshotId: UUID, against: UUID.optional() });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyRole } = req as CompanyAuthedRequest;
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  if (!mayReadAudit(companyRole)) return apiResponse.forbidden(res, `Your role (${companyRole ?? 'unknown'}) cannot compare audit snapshots.`);
  const q = Query.safeParse(req.query);
  if (!q.success) return apiResponse.validationError(res, q.error.flatten().fieldErrors);
  try {
    const p = principalFromRequest();
    // A comparison reads two ledgers: it takes one of the process's snapshot slots, refused (409) while they are full.
    const comparison = await withSnapshotSlot(p.companyId, false, () => (q.data.against
      ? compareSnapshots(p, q.data.snapshotId, q.data.against)
      : compareSnapshotToLive(p, q.data.snapshotId)));
    return apiResponse.success(res, { comparison });
  } catch (err) {
    if (respondAuditRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
