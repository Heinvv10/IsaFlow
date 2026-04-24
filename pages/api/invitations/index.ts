// pages/api/invitations/index.ts
import type { NextApiHandler } from 'next';
import crypto from 'node:crypto';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { adminCreateUser } from '@/lib/auth/gotrue';
import { checkRateLimit } from '@/lib/rateLimit';
import { sql } from '@/lib/neon';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { log } from '@/lib/logger';

const listInvitations: NextApiHandler = async (req, res) => {
  const { companyId } = req as CompanyAuthedRequest;
  const rows = await sql<{ id: string; email: string; role: string; expires_at: Date; accepted_at: Date | null; created_at: Date }>`
    SELECT id, email, role, expires_at, accepted_at, created_at
    FROM company_invitations
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return res.status(200).json({ success: true, data: rows });
};

const createInvitation: NextApiHandler = async (req, res) => {
  const request = req as CompanyAuthedRequest;
  const { companyId, companyRole, user } = request;
  if (!['owner', 'admin'].includes(companyRole)) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only owners and admins can invite' } });
  }

  // Pentest M25: owner/admin can loop this endpoint to exhaust SMTP budget
  // and trigger expensive GoTrue adminCreateUser calls. Cap per tenant.
  if (!(await checkRateLimit(`invitations:company:${companyId}`, { max: 20, windowSecs: 3600 }))) {
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many invitations. Try again later.' } });
  }

  const { email, role } = req.body ?? {};
  if (typeof email !== 'string' || typeof role !== 'string' || !['admin', 'manager', 'viewer', 'storeman', 'technician'].includes(role)) {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email and role required' } });
  }

  const cleanEmail = email.toLowerCase().trim();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // 1. Insert invitation row
  const inv = await sql<{ id: string }>`
    INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES (${companyId}::uuid, ${cleanEmail}, ${role}, ${user.id}, ${token}, ${expiresAt})
    RETURNING id
  `;

  // 2. Admin-create GoTrue user (email_confirm:true so they can sign in once password is set).
  //    On 422 (already exists) adminCreateUser returns the existing user via lookup.
  const gotrueUser = await adminCreateUser({
    email: cleanEmail,
    email_confirm: true,
    user_metadata: { invite_id: inv[0]!.id },
  });

  // 3. Stash gotrue_user_id on the invitation for later accept
  await sql`
    UPDATE company_invitations SET gotrue_user_id = ${gotrueUser.id}::uuid
    WHERE id = ${inv[0]!.id}::uuid
  `;

  // 4. Company name for the email
  const [company] = await sql<{ name: string }>`SELECT name FROM companies WHERE id = ${companyId}::uuid`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
  const acceptUrl = `${appUrl}/accept-invite?token=${token}`;

  // 5. Send our own email (Postmark-via-emailService)
  try {
    await sendEmail({
      to: cleanEmail,
      subject: `You've been invited to ${company?.name ?? 'IsaFlow'}`,
      html: `<p>You've been invited to join <strong>${company?.name ?? 'IsaFlow'}</strong> on IsaFlow.</p>
             <p><a href="${acceptUrl}">Accept invitation</a></p>
             <p>This link expires in 7 days.</p>`,
      _log: { companyId, emailType: 'invite' },
    });
    await sql`UPDATE company_invitations SET email_sent_at = now() WHERE id = ${inv[0]!.id}::uuid`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('invite email send failed', { inviteId: inv[0]!.id, message: msg }, 'Invitations');
    await sql`UPDATE company_invitations SET email_error = ${msg} WHERE id = ${inv[0]!.id}::uuid`;
    return res.status(502).json({ success: false, error: { code: 'EMAIL_FAILED', message: 'Invitation created but email delivery failed. You can resend.' } });
  }

  return res.status(201).json({ success: true, data: { id: inv[0]!.id, email: cleanEmail, role, expiresAt } });
};

const handler: NextApiHandler = async (req, res) => {
  if (req.method === 'GET') return listInvitations(req, res);
  if (req.method === 'POST') return createInvitation(req, res);
  return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET or POST' } });
};

export default withAuth(handler);
