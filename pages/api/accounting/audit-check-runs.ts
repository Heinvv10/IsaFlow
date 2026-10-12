/**
 * Audit check runs (forensic-controls step 4, migration 890): the fifteen
 * integrity checks, the anomaly scan and the journal-risk set, recorded and
 * sealed. A snapshot embeds one; this route also takes one on its own.
 * GET  (owner / admin / manager)  no id: the company's runs; ?id=: one run with its results and findings.
 * POST { asAt } (owner / admin, a person in their own session) — run every check now, as at that date.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { assertHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { AuditDate, mayReadAudit, mayTakeAudit, respondAuditRefusal } from '@/modules/accounting/services/audit/auditAccess';
import { principalFromRequest } from '@/modules/accounting/services/audit/auditTx';
import { takeCheckRun } from '@/modules/accounting/services/audit/checks/checkRunService';
import { getCheckRun, listCheckRuns } from '@/modules/accounting/services/audit/snapshotRead';

const Query = z.object({ id: UUID.optional() });
const Body = z.object({ asAt: AuditDate }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (req.method !== 'GET' && req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
  if (!mayReadAudit(companyRole)) return apiResponse.forbidden(res, `Your role (${companyRole ?? 'unknown'}) cannot view audit check runs.`);
  try {
    if (req.method === 'GET') {
      const q = Query.safeParse(req.query);
      if (!q.success) return apiResponse.validationError(res, q.error.flatten().fieldErrors);
      if (!q.data.id) return apiResponse.success(res, { runs: await listCheckRuns(companyId) });
      const run = await getCheckRun(companyId, q.data.id);
      return run ? apiResponse.success(res, { run }) : apiResponse.notFound(res, 'Check run');
    }
    if (!mayTakeAudit(companyRole)) return apiResponse.forbidden(res, 'Only an owner or admin can run the audit checks.');
    const b = Body.safeParse(req.body ?? {});
    if (!b.success) return apiResponse.validationError(res, b.error.flatten().fieldErrors);
    await assertHumanSession('run the audit checks');
    const run = await takeCheckRun(principalFromRequest(), b.data.asAt);
    return apiResponse.created(res, { run: { id: run.id, canonicalHash: run.canonicalHash, takenAt: run.takenAt,
      failed: run.results.filter((r) => r.status === 'fail').length, findings: run.results.reduce((n, r) => n + r.findingCount, 0) } });
  } catch (err) {
    if (respondAuditRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
