// pages/api/auth/switch-company.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withTransaction } from '@/lib/neon';
import { setActiveCompanyCookie } from '@/lib/auth/cookies';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const user = (req as UserAuthedRequest).user;
  const { companyId } = req.body ?? {};
  if (typeof companyId !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'companyId required' } });
  }

  // Membership lookup must run with `request.jwt.claims` populated so the
  // `cu_self_or_admin` RLS policy on company_users (which compares `auth.uid()`
  // against `user_id`) lets the user see their own row. withUserAuth — unlike
  // withAuth — does NOT set up RLS context, so we open a short transaction
  // here and set it explicitly for this single query.
  let memberFound = false;
  try {
    memberFound = await withTransaction(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(user.claims)}, true)`;
      const rows = await tx`
        SELECT 1 AS exists FROM company_users
        WHERE user_id = ${user.id} AND company_id = ${companyId}::uuid
        LIMIT 1
      `;
      return rows.length > 0;
    });
  } catch {
    // pg rejects malformed UUIDs at cast time. A forged cookie shouldn't
    // surface a different error than a real miss — treat as "not a member".
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of that company' } });
  }

  if (!memberFound) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of that company' } });
  }

  setActiveCompanyCookie(res, companyId);
  return res.status(200).json({ success: true, data: { activeCompanyId: companyId } });
};

export default withUserAuth(withCsrf(handler));
