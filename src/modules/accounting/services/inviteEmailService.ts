/**
 * Invite Email Service
 * Sends company-invitation emails via the shared sendEmail helper.
 */

import { inviteEmailHtml } from '@/lib/email-templates';
import type { InviteEmailData } from '@/lib/email-templates';
import { sendEmail } from './emailService';
import type { EmailResult } from './emailService';

export interface InviteEmailOptions {
  recipientEmail: string;
  inviteToken: string;
  companyName: string;
  inviterName: string;
  role: string;
  baseUrl: string;
}

export async function sendInviteEmail(options: InviteEmailOptions): Promise<EmailResult> {
  const inviteUrl = `${options.baseUrl}/invite/${options.inviteToken}`;

  const inviteData: InviteEmailData = {
    inviterName: options.inviterName,
    companyName: options.companyName,
    role: options.role,
    inviteUrl,
    recipientEmail: options.recipientEmail,
  };

  return sendEmail({
    to: options.recipientEmail,
    subject: `You've been invited to join ${options.companyName} on ISAFlow`,
    html: inviteEmailHtml(inviteData),
    _log: { companyId: null, emailType: 'invite' },
  });
}
