// pages/api/invitations/[token]/index.ts
import type { NextApiHandler } from 'next';
import { withInviteToken, type InviteTokenRequest } from '@/lib/auth/withInviteToken';
import { sql } from '@/lib/neon';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } });
  }
  const token = (req as InviteTokenRequest).inviteToken;
  const rows = await sql<{
    id: string; email: string; role: string; expires_at: Date; company_name: string;
  }>`
    SELECT ci.id, ci.email, ci.role, ci.expires_at, c.name AS company_name
    FROM company_invitations ci
    JOIN companies c ON c.id = ci.company_id
    WHERE ci.token = ${token}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(410).json({ success: false, error: { code: 'INVALID_OR_EXPIRED', message: 'Invitation not found, expired, or already accepted' } });
  }
  return res.status(200).json({ success: true, data: rows[0] });
};

export default withInviteToken(handler);
