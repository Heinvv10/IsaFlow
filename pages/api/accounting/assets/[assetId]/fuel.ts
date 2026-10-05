/**
 * Fuel fills of a vehicle held as a fixed asset (mig 853).
 *
 * GET    /api/accounting/assets/:assetId/fuel          — the asset's fuel records, newest first
 * POST   /api/accounting/assets/:assetId/fuel          — body `FuelRecordBody`; 201 with the record
 * DELETE /api/accounting/assets/:assetId/fuel?id=<id>  — 409 while a bank line links to it (unlink it first)
 *
 * An asset that is missing or another company's is 404 — one answer for both. Writes: CSRF + write access.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { FuelRecordBody } from '@/lib/schemas/fleet';
import { createFuelRecord, deleteFleetRecord, listFuelRecords } from '@/modules/accounting/services/items/fleetRecordsService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const assetId = UUID.safeParse(req.query.assetId);
  if (!assetId.success) return apiResponse.notFound(res, 'Asset');

  if (req.method === 'GET') {
    const rows = await listFuelRecords(companyId, assetId.data);
    return rows ? apiResponse.success(res, rows) : apiResponse.notFound(res, 'Asset');
  }

  if (req.method === 'POST') {
    const parsed = FuelRecordBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    const made = await createFuelRecord(companyId, assetId.data, parsed.data, String(req.user.id));
    if (!made) return apiResponse.notFound(res, 'Asset');
    log.info('Fuel record created', { assetId: assetId.data, id: made.id }, 'assets-fleet');
    return apiResponse.created(res, made, 'Fuel record added');
  }

  if (req.method === 'DELETE') {
    const id = UUID.safeParse(req.query.id);
    if (!id.success) return apiResponse.badRequest(res, 'id must be a UUID');
    const out = await deleteFleetRecord(companyId, assetId.data, 'fuel', id.data);
    if (out === 'not_found') return apiResponse.notFound(res, 'Fuel record');
    if (out === 'linked') {
      return apiResponse.conflict(res, 'A bank transaction is linked to this fuel record — unlink it on the bank transaction first.');
    }
    log.info('Fuel record deleted', { assetId: assetId.data, id: id.data }, 'assets-fleet');
    return apiResponse.success(res, { deleted: true, id: id.data });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

// withCsrf and withWriteAccess pass GET through; POST / DELETE need CSRF and write access (a `viewer` gets 403).
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
