/**
 * POST /api/payroll/runs/[id]/payslips/email  { employeeIds?: uuid[], resend?: boolean }
 * Email a final run's payslips, one password-protected PDF per employee (wave 6 PE). The handler, its refusals and
 * what it records: src/lib/payslipEmailApi.ts and payslipDeliveryService.ts. It sends through `sendEmail`; nothing
 * else is selectable here.
 */
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { payslipEmailHandler, type AdmitPayslipEmails } from '@/lib/payslipEmailApi';
import { checkSendRateLimit } from '@/lib/rateLimit';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

/**
 * Weighted by recipients; a payroll's employees fit in one company window. Unused units come back: sendEmail records
 * each message the mail server accepted (markQuotaUsed('send')).
 */
export const admitPayslipEmails: AdmitPayslipEmails = (req, companyId, count) =>
  checkSendRateLimit(req, companyId, 'payslips', { count, companyMax: 500, dailyMax: 1000, refundUnused: true });

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(payslipEmailHandler(sendEmail, admitPayslipEmails))))));
