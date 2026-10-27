// pages/api/invitations/[token]/index.ts
import type { NextApiHandler } from 'next';
import { withInviteToken, type InviteTokenRequest } from '@/lib/auth/withInviteToken';
import { withErrorHandler } from '@/lib/api-error-handler';
import { sql } from '@/lib/neon';
import { maskInviteEmail } from '@/lib/auth/maskInviteEmail';

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
    company_name: string;
  }>`
    SELECT ci.id, ci.email, ci.role, ci.expires_at,
           invite_token_company_name() AS company_name
    FROM company_invitations ci
    WHERE ci.token = ${tokenHash}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(410).json({ success: false, error: { code: 'INVALID_OR_EXPIRED', message: 'Invitation not found, expired, or already accepted' } });
  }
  // Anyone holding the link can read this, so the address is masked — the invitee already knows their own.
  const invite = rows[0]!;
  return res.status(200).json({ success: true, data: { ...invite, email: maskInviteEmail(invite.email) } });
};

// withErrorHandler OUTSIDE withInviteToken: withInviteToken rethrows after its
// ROLLBACK, and without a handler above it a throw answers a bare Next 500 HTML
// page. pages/accept-invite.tsx then fails to parse it and shows "Network error"
// instead of the real failure. Outside, not inside, so the rollback still runs
// before the JSON error is written.
export default withErrorHandler(withInviteToken(handler));
