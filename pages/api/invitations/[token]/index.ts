// pages/api/invitations/[token]/index.ts
import type { NextApiHandler } from 'next';
import { withInviteToken, type InviteTokenRequest } from '@/lib/auth/withInviteToken';
import { sql } from '@/lib/neon';

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  return `${local[0]}***@${domain}`;
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } });
  }
  const tokenHash = (req as InviteTokenRequest).inviteTokenHash;
  // No join onto `companies`: a row policy there would expose all 163 columns
  // of the tenant row, including the Netcash keys and the bank account number,
  // to whoever holds the link. Migration 648 returns the one column this needs
  // through a SECURITY DEFINER function scoped to this session's own token.
  const rows = await sql<{
    id: string; email: string; role: string; expires_at: Date;
    company_name: string; gotrue_user_id: string | null;
  }>`
    SELECT ci.id, ci.email, ci.role, ci.expires_at, ci.gotrue_user_id,
           invite_token_company_name() AS company_name
    FROM company_invitations ci
    WHERE ci.token = ${tokenHash}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(410).json({ success: false, error: { code: 'INVALID_OR_EXPIRED', message: 'Invitation not found, expired, or already accepted' } });
  }
  // Unifying the token encoding made userInvitationService's invitations match
  // here too, and that path never writes gotrue_user_id — there is no GoTrue
  // user for /accept to set a password on. Those are accepted at /invite/<token>
  // by an already-signed-in user, so send the invitee there instead of showing
  // a form that cannot complete.
  if (rows[0]!.gotrue_user_id === null) {
    return res.status(409).json({ success: false, error: { code: 'WRONG_INVITE_FLOW', message: 'This invitation is accepted from the invitation page, not here.' } });
  }
  // Anyone holding the link can read this. Mask the address the same way
  // pages/api/invite/[token].ts does — the invitee already knows their own.
  const { gotrue_user_id: _unused, ...invite } = rows[0]!;
  return res.status(200).json({ success: true, data: { ...invite, email: maskEmail(invite.email) } });
};

export default withInviteToken(handler);
