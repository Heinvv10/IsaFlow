/**
 * GET /api/employee-portal/irp5/[versionId]: a copy of the signed-in employee's own IRP5 from that FILED EMP501
 * version, as a PDF (wave 6 SS-c; employeePortalIrp5.ownCertificate, employeePortalIrp5Pdf). Another employee's,
 * another company's, a finalised-not-filed or a superseded version: the same 404. Rate-limited per employee.
 * Rendered in memory; no-store.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withEmployeePortalAuth, type EmployeePortalRequest } from '@/lib/auth/employeePortalAuth';
import { UUID } from '@/lib/payslipEmailApi';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { ownCertificate } from '@/modules/accounting/services/payroll/employeePortalIrp5';
import { buildIrp5CopyPdf, irp5CopyFilename } from '@/modules/accounting/services/payroll/employeePortalIrp5Pdf';

async function handler(req: EmployeePortalRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const versionId = req.query.versionId;
  if (typeof versionId !== 'string' || !UUID.test(versionId)) return apiResponse.badRequest(res, 'versionId must be a UUID');
  const { companyId, employeeId } = req.employeePortal;
  if (!(await checkReportRateLimit(companyId, `employee-portal-irp5:e:${employeeId}`, INTERACTIVE_REPORT_LIMIT))) {
    return apiResponse.tooManyRequests(res, 'Too many downloads. Please try again shortly.');
  }
  const cert = await ownCertificate(companyId, employeeId, versionId);
  if (!cert) return apiResponse.notFound(res, 'IRP5 certificate');
  const pdf = await buildIrp5CopyPdf(cert);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${irp5CopyFilename(cert)}"`);
  res.setHeader('Content-Length', pdf.length);
  return res.status(200).send(pdf);
}

export default withErrorHandler(withEmployeePortalAuth(handler));
