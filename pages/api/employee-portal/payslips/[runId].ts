/**
 * GET /api/employee-portal/payslips/[runId]: the signed-in employee's own final payslip on that run, as a PDF
 * (wave 6 SS; employeePortalReads.ownPayslipPdf). Another employee's run, another company's, a draft, a reopened or
 * a not-frozen run: all the same 404. Rate-limited per employee. Rendered in memory; no-store.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withEmployeePortalAuth, type EmployeePortalRequest } from '@/lib/auth/employeePortalAuth';
import { UUID } from '@/lib/payslipEmailApi';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { ownPayslipPdf } from '@/modules/accounting/services/payroll/employeePortalReads';

async function handler(req: EmployeePortalRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const runId = req.query.runId;
  if (typeof runId !== 'string' || !UUID.test(runId)) return apiResponse.badRequest(res, 'runId must be a UUID');
  const { companyId, employeeId } = req.employeePortal;
  if (!(await checkReportRateLimit(companyId, `employee-portal-payslip:e:${employeeId}`, INTERACTIVE_REPORT_LIMIT))) {
    return apiResponse.tooManyRequests(res, 'Too many downloads. Please try again shortly.');
  }
  const slip = await ownPayslipPdf(companyId, employeeId, runId);
  if (!slip) return apiResponse.notFound(res, 'Payslip');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slip.filename}"`);
  res.setHeader('Content-Length', slip.pdf.length);
  return res.status(200).send(slip.pdf);
}

export default withErrorHandler(withEmployeePortalAuth(handler));
