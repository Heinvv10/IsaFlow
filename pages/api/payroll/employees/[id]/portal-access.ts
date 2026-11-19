/**
 * GET    /api/payroll/employees/[id]/portal-access   the employee's portal login as the employer sees it   payroll-detail roles
 * POST   /api/payroll/employees/[id]/portal-access   invite (email a link to choose a password)            owner / admin, own session, never Login-as
 * DELETE /api/payroll/employees/[id]/portal-access   revoke (ends the login and every session)              owner / admin, own session, never Login-as
 *
 * Wave 6 SS (employeePortalAccess, src/lib/employeePortalApi.ts). The invite needs the platform switch, then the
 * company setting (rule 20); it sends through `sendEmail`. Every response is no-store.
 */
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import type { NextApiRequest } from 'next';
import { employeePortalAccessHandler } from '@/lib/employeePortalApi';
import { checkSendRateLimit } from '@/lib/rateLimit';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

/** One invitation email per request; kept whatever happens (an invite is cheap and rare). */
export const admitPortalInvite = (req: NextApiRequest, companyId: string) =>
  checkSendRateLimit(req, companyId, 'employee-portal-invite', { ipMax: 30, companyMax: 60, dailyMax: 200 });

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(employeePortalAccessHandler(sendEmail, admitPortalInvite))))));
