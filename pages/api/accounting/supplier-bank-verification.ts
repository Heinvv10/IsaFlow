/**
 * Supplier bank-detail verification API (forensic-controls step 1).
 * GET  ?supplierId= — the supplier's verification state (derived), masked bank
 *      details, the fingerprint of what is shown, whether the viewer may
 *      verify, and the latest 20 verifications.
 * POST { supplierId, fingerprint, method, note } — the signed-in person
 *      verifies the details they SAW (`fingerprint` from the GET): 409 when
 *      they changed since (FINGERPRINT_STALE), the control is off, there are
 *      none, or they are already verified; 403 for an impersonated or
 *      claim-less session, a role below the verifier role, or a setter of the
 *      details while another member could verify; 404 for a supplier of
 *      another company. Nothing is written on a refusal.
 * Cookie sessions only (withAuth); no MCP tool reaches the verify (census).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { isUuidParam } from '@/lib/validation';
import {
  getSupplierBankVerification, isVerificationMethod, NOTE_MAX, verifySupplierBankDetails, VERIFICATION_METHODS,
} from '@/modules/accounting/services/ap/supplierBankVerification';
import { SupplierBankVerificationError } from '@/modules/accounting/services/ap/supplierBankBaseline';

const FINGERPRINT = /^[0-9a-f]{64}$/;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId, user } = req;

  if (req.method === 'GET') {
    const { supplierId } = req.query;
    if (!isUuidParam(supplierId)) return apiResponse.badRequest(res, 'supplierId must be a UUID');
    const view = await getSupplierBankVerification(companyId, supplierId, { userId: user.id });
    if (!view) return apiResponse.notFound(res, 'Supplier', supplierId);
    return apiResponse.success(res, view);
  }

  if (req.method === 'POST') {
    const { supplierId, fingerprint, method, note } = (req.body ?? {}) as Record<string, unknown>;
    if (!isUuidParam(supplierId)) return apiResponse.badRequest(res, 'supplierId must be a UUID');
    if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) {
      return apiResponse.badRequest(res, 'fingerprint must be the one the supplier\'s bank details were shown with');
    }
    if (!isVerificationMethod(method)) {
      return apiResponse.badRequest(res, `method must be one of: ${VERIFICATION_METHODS.join(', ')}`);
    }
    if (typeof note !== 'string' || note.trim().length === 0 || note.trim().length > NOTE_MAX) {
      return apiResponse.badRequest(res, `note is required: how the details were confirmed, at most ${NOTE_MAX} characters`);
    }
    try {
      const done = await verifySupplierBankDetails({
        companyId, userId: user.id, email: user.email, supplierId, fingerprint, method, note,
      });
      return apiResponse.success(res, done);
    } catch (err) {
      if (!(err instanceof SupplierBankVerificationError)) throw err;
      if (err.status === 404) return apiResponse.notFound(res, 'Supplier', supplierId);
      return apiResponse.error(res, err.status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.CONFLICT, err.message, { reason: err.code });
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
