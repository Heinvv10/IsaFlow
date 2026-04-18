// pages/api/invitations/[id]/revoke.ts
import type { NextApiHandler } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { adminDeleteUser } from '@/lib/auth/gotrue';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }
  const request = req as CompanyAuthedRequest;
  if (!['owner', 'admin'].includes(request.companyRole)) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Owner/admin only' } });
  }
  const id = req.query.id as string | undefined;
  if (!id) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'id required' } });

  const rows = await sql<{ gotrue_user_id: string; accepted_at: Date | null }>`
    SELECT gotrue_user_id, accepted_at FROM company_invitations
    WHERE id = ${id}::uuid AND company_id = ${request.companyId}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } });
  }
  if (rows[0]!.accepted_at !== null) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_ACCEPTED', message: 'Invitation already accepted' } });
  }

  // Delete the invitation row. Delete the orphan GoTrue user only if they have
  // no other company memberships — otherwise they're a real user of another
  // company and we just drop the invite.
  const otherMemberships = await sql<{ count: number }>`
    SELECT COUNT(*)::int AS count FROM company_users WHERE user_id = ${rows[0]!.gotrue_user_id}
  `;
  await sql`DELETE FROM company_invitations WHERE id = ${id}::uuid`;
  if ((otherMemberships[0]!.count ?? 0) === 0) {
    try { await adminDeleteUser(rows[0]!.gotrue_user_id); }
    catch (err) { log.info('revoke: adminDeleteUser non-fatal', { message: err instanceof Error ? err.message : String(err) }, 'Invitations'); }
  }

  return res.status(200).json({ success: true, data: null });
};

export default withAuth(handler);
