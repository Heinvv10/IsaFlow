// pages/api/invitations/[id]/revoke.ts
import type { NextApiHandler } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { adminDeleteUser } from '@/lib/auth/gotrue';
import { adminGetUser } from '@/lib/auth/gotrueAdminUser';
import { sql } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
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

  // Delete the invitation row, and the GoTrue account pinned to it only when it is this invitation's own unused
  // placeholder: THIS invitation created it (POST /api/invitations stamps user_metadata.invite_id; a Settings pin
  // names an account that already held the address and is never removed here), nobody has ever signed in to it
  // (#1517 B1), and nothing else needs it: no membership and no OTHER pending invitation pinned to it, in any
  // company (#1517 B2: that invitation would be left on IDENTITY_MISMATCH). Counted on the migration_admin pool:
  // this request's pool sees only this company's rows (RLS).
  const pinned = rows[0]!.gotrue_user_id;
  const holds = pinned ? (await migrationAdminPool().query<{ n: number }>(
    `SELECT (SELECT count(*) FROM company_users WHERE user_id::text = $1)
          + (SELECT count(*) FROM company_invitations
              WHERE gotrue_user_id = $1::uuid AND accepted_at IS NULL AND id <> $2::uuid) AS n`,
    [pinned, id],
  )).rows[0]?.n : null;
  await sql`DELETE FROM company_invitations WHERE id = ${id}::uuid`;
  if (pinned && Number(holds) === 0) {
    try {
      const account = await adminGetUser(pinned);
      if (account?.user_metadata?.invite_id === id.toLowerCase() && !account.last_sign_in_at) await adminDeleteUser(pinned);
    } catch (err) { log.info('revoke: adminDeleteUser non-fatal', { message: err instanceof Error ? err.message : String(err) }, 'Invitations'); }
  }

  return res.status(200).json({ success: true, data: null });
};

export default withAuth(withCsrf(handler));
