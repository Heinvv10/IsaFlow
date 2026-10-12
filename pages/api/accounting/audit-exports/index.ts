/**
 * /api/accounting/audit-exports
 *   GET  — list exports for this company (owner / admin / manager — writers of the pack flow)
 *   POST — build an audit pack FROM a sealed snapshot (forensic-controls step 4), owner / admin in their own session:
 *          { periodStart, snapshotId }               from an existing snapshot (the pack ends at its cutoff), or
 *          { periodStart, periodEnd }                take a snapshot at periodEnd now, then build from it;
 *          includeComparison: true adds comparison.csv (the snapshot against today's books).
 *          The ZIP's manifest cites the snapshot's canonical hash and HMAC; the PDF is rendered from its rows.
 */
import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql, withSavepoint } from '@/lib/neon';
import { UUID } from '@/lib/schemas/common';
import { listExports, createExport, getExport } from '@/modules/accounting/services/capture/auditTrailExportService';
import { assertHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { AuditDate, mayReadAudit, mayTakeAudit, respondAuditRefusal } from '@/modules/accounting/services/audit/auditAccess';
import { principalFromRequest } from '@/modules/accounting/services/audit/auditTx';
import { takeSnapshot } from '@/modules/accounting/services/audit/snapshotService';
import { getSnapshot } from '@/modules/accounting/services/audit/snapshotRead';
import { compareSnapshotToLive } from '@/modules/accounting/services/audit/comparisonService';
import { buildSnapshotPack, storePack } from '@/modules/accounting/services/audit/packExport';
import { withSnapshotSlot } from '@/modules/accounting/services/audit/snapshotSlots';

/** The build failed after its draft was created (and marked failed): answered as a refusal or a 400. */
class PackBuildFailed extends Error {
  constructor(message: string, readonly reason: unknown) { super(message); this.name = 'PackBuildFailed'; }
}

const Body = z.object({
  periodStart: AuditDate,
  periodEnd: AuditDate.optional(),
  snapshotId: UUID.optional(),
  includeComparison: z.boolean().optional(),
  includeSourceDocs: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

async function build(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  if (!mayTakeAudit(req.companyRole)) return apiResponse.forbidden(res, 'Only an owner or admin can build an audit pack.');
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  const body = parsed.data;
  if (!body.snapshotId && !body.periodEnd) return apiResponse.badRequest(res, 'Give a snapshotId, or a periodEnd to snapshot now.');
  await assertHumanSession('build an audit pack');
  const principal = principalFromRequest();
  const snapshotId = body.snapshotId ?? (await takeSnapshot(principal, { cutoff: body.periodEnd!, trigger: 'manual' })).id;
  const snapshot = await getSnapshot(companyId, snapshotId);
  if (!snapshot) return apiResponse.notFound(res, 'Audit snapshot');
  if (snapshot.status !== 'sealed') return apiResponse.badRequest(res, 'That snapshot attempt failed; build from a sealed snapshot.');
  if (body.periodEnd && body.periodEnd !== snapshot.cutoff) {
    return apiResponse.badRequest(res, `The pack ends at the snapshot's cutoff (${snapshot.cutoff}), not ${body.periodEnd}.`);
  }
  if (body.periodStart > snapshot.cutoff) return apiResponse.badRequest(res, 'periodStart is after the snapshot\'s cutoff.');

  // The build reads the whole ledger (verify, optional comparison, the pack's rows): it holds one of the process's
  // audit slots, refused (409) while none is free — before a draft export is created.
  let draftId: string;
  try {
    draftId = await withSnapshotSlot(companyId, false, async () => {
      const draft = await createExport({
        companyId, periodStart: body.periodStart, periodEnd: snapshot.cutoff, includeSourceDocs: body.includeSourceDocs,
        requestedBy: req.user?.id ?? null, expiresAt: body.expiresAt ?? null,
      });
      try {
        await withSavepoint('audit_pack_build', async () => {
          const [company] = (await sql`SELECT name FROM companies WHERE id = ${companyId}::UUID`) as { name: string }[];
          const comparison = body.includeComparison ? await compareSnapshotToLive(principal, snapshotId) : null;
          const pack = await buildSnapshotPack(draft, snapshotId, company?.name ?? 'ISAFlow', comparison);
          await storePack(draft, snapshotId, pack);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await sql`UPDATE audit_trail_exports SET status = 'failed', error = ${msg}, snapshot_id = ${snapshotId}::UUID
                  WHERE id = ${draft.id}::UUID AND company_id = ${companyId}::UUID`;
        throw new PackBuildFailed(msg, err);
      }
      return draft.id;
    });
  } catch (err) {
    if (respondAuditRefusal(res, err instanceof PackBuildFailed ? err.reason : err)) return;
    if (err instanceof PackBuildFailed) return apiResponse.badRequest(res, `Build failed: ${err.message}`);
    throw err;
  }
  return apiResponse.created(res, { export: await getExport(draftId, companyId) });
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    if (!mayReadAudit(req.companyRole)) return apiResponse.forbidden(res, `Your role (${req.companyRole ?? 'unknown'}) cannot view audit packs.`);
    const exports = await listExports(req.companyId);
    return apiResponse.success(res, { exports, total: exports.length });
  }
  if (req.method === 'POST') {
    try {
      return await build(req, res);
    } catch (err) {
      if (respondAuditRefusal(res, err)) return;
      throw err;
    }
  }
  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
