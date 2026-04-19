/**
 * Payslip PDF for a specific (run, employee).
 * GET /api/payroll/runs/[id]/payslip/[employeeId] — streams application/pdf.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { generatePayslipPdf } from '@/modules/accounting/services/payroll/payslipPdfService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { id, employeeId } = req.query;
  if (typeof id !== 'string' || typeof employeeId !== 'string') {
    return apiResponse.badRequest(res, 'Invalid id or employeeId');
  }

  const pdf = await generatePayslipPdf(companyId, id, employeeId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="payslip-${id}-${employeeId}.pdf"`,
  );
  res.send(pdf);
}

// Read-only route — no withCsrf needed, but still auth-gated.
export default withAuth(withErrorHandler(handler));
