/**
 * IRP6 Provisional Tax API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { buildIRP6Payload, validateSARSSubmission } from '@/modules/accounting/services/sarsEfilingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return apiResponse.success(res, { message: 'Use POST to generate IRP6 provisional tax estimate' });
  }
  if (req.method === 'POST') {
    const { taxYear, period, taxableIncome, taxCredits, previousPayments, companyName, taxNumber } = req.body;
    const validation = validateSARSSubmission({ taxType: 'IRP6', taxPeriod: `${taxYear}-P${period}` });
    if (!validation.valid) return apiResponse.badRequest(res, 'Validation failed', validation.errors);
    const payload = buildIRP6Payload({
      taxYear: taxYear || new Date().getFullYear(),
      period: period || 1,
      taxableIncome: Number(taxableIncome || 0),
      taxCredits: Number(taxCredits || 0),
      previousPayments: Number(previousPayments || 0),
      companyName: companyName || '',
      taxNumber: taxNumber || '',
    });
    return apiResponse.success(res, payload);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withCompany(withErrorHandler(handler as any));
