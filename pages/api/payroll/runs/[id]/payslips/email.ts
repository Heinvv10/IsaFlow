/**
 * POST /api/payroll/runs/[id]/payslips/email  { employeeIds?: uuid[], resend?: boolean }
 * Email a final run's payslips, one password-protected PDF per employee (wave 6 PE). The route, its refusals and
 * what it records: src/lib/payslipEmailApi.ts and payslipDeliveryService.ts. It sends through `sendEmail`; nothing
 * else is selectable here.
 */
import { payslipEmailRoute } from '@/lib/payslipEmailApi';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

export default payslipEmailRoute(sendEmail);
