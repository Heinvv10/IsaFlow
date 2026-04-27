// pages/api/auth/switch-company.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
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

  const member = await sql`
    SELECT 1 FROM company_users WHERE user_id = ${user.id} AND company_id = ${companyId}::uuid LIMIT 1
  `;
  if (member.length === 0) {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of that company' } });
  }

  setActiveCompanyCookie(res, companyId);
  return res.status(200).json({ success: true, data: { activeCompanyId: companyId } });
};

export default withUserAuth(withCsrf(handler));
