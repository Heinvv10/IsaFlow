/**
 * Company Invitations API
 * GET    — list pending invitations for the active company
 * POST   — create invitation { email, role }   (owner/admin only)
 * DELETE — cancel invitation { invitationId }  (owner/admin only)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  listPendingInvitations,
  createInvitation,
  cancelInvitation,
  markInvitationEmailSent,
  markInvitationEmailFailed,
} from '@/modules/accounting/services/userAccessService';
import { sendInviteEmail } from '@/modules/accounting/services/emailService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const ADMIN_ROLES = ['owner', 'admin'];
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyApiRequest;
  const { companyId, companyRole } = companyReq;

  // GET — list pending invitations
  if (req.method === 'GET') {
    if (!ADMIN_ROLES.includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only owners and admins can view invitations.');
    }
    const invitations = await listPendingInvitations(companyId);
    return apiResponse.success(res, invitations);
  }

  // POST — send invitation
  if (req.method === 'POST') {
    if (!ADMIN_ROLES.includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only owners and admins can invite users.');
    }

    const { email, role } = req.body as { email?: string; role?: string };
    if (!email || !role) {
      return apiResponse.badRequest(res, 'email and role are required.');
    }

    const emailLower = email.toLowerCase().trim();
    if (!emailLower.includes('@')) {
      return apiResponse.badRequest(res, 'A valid email address is required.');
    }

    const invitedBy = companyReq.user.id;
    const inviterName = companyReq.user.name || companyReq.user.email;

    try {
      const result = await createInvitation(companyId, emailLower, role, invitedBy);

      // Path 1: user already existed — auto-added, no email needed
      if (result.autoAdded || !result.invitation) {
        return apiResponse.success(res, { ...result, emailSent: false });
      }

      // Path 2: invitation token created — look up company name and send email
      const companyRows = (await sql`
        SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1
      `) as Row[];
      const companyName = (companyRows[0]?.name as string | undefined) ?? 'ISaFlow';

      const invitationId = result.invitation.id;
      const token = result.invitation.token;

      let emailSent = false;
      try {
        const emailResult = await sendInviteEmail({
          recipientEmail: emailLower,
          inviteToken: token,
          companyName,
          inviterName,
          role,
          baseUrl: BASE_URL,
        });

        if (emailResult.success) {
          emailSent = true;
          await markInvitationEmailSent(invitationId);
          log.info('Invite email sent', { invitationId, to: emailLower }, 'company-invitations');
        } else {
          await markInvitationEmailFailed(invitationId, emailResult.error ?? 'Unknown error');
          log.warn('Invite email failed to send', { invitationId, error: emailResult.error }, 'company-invitations');
        }
      } catch (emailErr) {
        const errMsg = emailErr instanceof Error ? emailErr.message : 'Email send threw';
        await markInvitationEmailFailed(invitationId, errMsg).catch(() => undefined);
        log.error('Invite email threw', { invitationId, error: errMsg }, 'company-invitations');
      }

      return apiResponse.success(res, { ...result, emailSent });
    } catch (err) {
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Invite failed.');
    }
  }

  // DELETE — cancel invitation
  if (req.method === 'DELETE') {
    if (!ADMIN_ROLES.includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only owners and admins can cancel invitations.');
    }

    const { invitationId } = req.body as { invitationId?: string };
    if (!invitationId) {
      return apiResponse.badRequest(res, 'invitationId is required.');
    }

    await cancelInvitation(invitationId, companyId);
    return apiResponse.success(res, { cancelled: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
