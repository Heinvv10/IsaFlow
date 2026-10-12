/**
 * Audit snapshots (forensic-controls step 4, migration 890).
 * GET  (owner / admin / manager)
 *   no id                               the company's snapshots, newest first (failed attempts included), and the
 *                                       closes / VAT locks whose automatic snapshot was never recorded (`unrecorded`)
 *   ?id=                                one snapshot + its check run with results and findings
 *   ?id=&section=tb                     its trial balance
 *   ?id=&section=journals&page=&size=   its journals, paged
 *   ?id=&section=lines&journalId=       one journal's lines
 *   ?id=&verify=1                       recompute every hash and check the seal
 * POST { cutoff } (owner / admin, a person in their own session) — take a snapshot now.
 * RLS (890) enforces the same reading rules underneath; the writer the same taking rules.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { assertHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { AuditDate, mayReadAudit, mayTakeAudit, respondAuditRefusal } from '@/modules/accounting/services/audit/auditAccess';
import { principalFromRequest } from '@/modules/accounting/services/audit/auditTx';
import { takeSnapshot } from '@/modules/accounting/services/audit/snapshotService';
import { getCheckRun, getSnapshot, listSnapshots, snapshotRows, snapshotTb, unrecordedLocks } from '@/modules/accounting/services/audit/snapshotRead';
import { verifySnapshot } from '@/modules/accounting/services/audit/snapshotVerify';

const Query = z.object({
  id: UUID.optional(),
  section: z.enum(['tb', 'journals', 'lines']).optional(),
  journalId: UUID.optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(500).default(100),
  verify: z.enum(['1']).optional(),
});
const Body = z.object({ cutoff: AuditDate }).strict();

async function get(req: NextApiRequest, res: NextApiResponse, companyId: string) {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  const q = parsed.data;
  if (!q.id) return apiResponse.success(res, { snapshots: await listSnapshots(companyId), unrecorded: await unrecordedLocks(companyId) });
  const snapshot = await getSnapshot(companyId, q.id);
  if (!snapshot) return apiResponse.notFound(res, 'Audit snapshot');
  if (q.verify) return apiResponse.success(res, { verification: await verifySnapshot(companyId, q.id) });
  if (q.section === 'tb') return apiResponse.success(res, { rows: await snapshotTb(companyId, q.id) });
  if (q.section === 'journals') {
    const rows = await snapshotRows(companyId, q.id, 'journals', { page: q.page, size: q.size });
    return apiResponse.success(res, { rows, page: q.page, size: q.size, total: Number(snapshot.totals.journal_count ?? 0) });
  }
  if (q.section === 'lines') {
    if (!q.journalId) return apiResponse.badRequest(res, 'journalId is required for section=lines');
    return apiResponse.success(res, { rows: await snapshotRows(companyId, q.id, 'lines', { journalId: q.journalId }) });
  }
  const checkRun = snapshot.checkRunId ? await getCheckRun(companyId, snapshot.checkRunId) : null;
  return apiResponse.success(res, { snapshot, checkRun });
}

async function post(req: NextApiRequest, res: NextApiResponse, role: string | undefined) {
  if (!mayTakeAudit(role)) return apiResponse.forbidden(res, 'Only an owner or admin can take an audit snapshot.');
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  await assertHumanSession('take an audit snapshot');
  const principal = principalFromRequest();
  const taken = await takeSnapshot(principal, { cutoff: parsed.data.cutoff, trigger: 'manual' });
  log.info('audit snapshot taken', { companyId: principal.companyId, snapshotId: taken.id, cutoff: taken.cutoff,
    lines: taken.lines, durationMs: taken.durationMs }, 'audit');
  return apiResponse.created(res, { snapshot: taken });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (req.method !== 'GET' && req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
  if (!mayReadAudit(companyRole)) {
    return apiResponse.forbidden(res, `Your role (${companyRole ?? 'unknown'}) cannot view audit snapshots.`);
  }
  try {
    return req.method === 'GET' ? await get(req, res, companyId) : await post(req, res, companyRole);
  } catch (err) {
    if (respondAuditRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
