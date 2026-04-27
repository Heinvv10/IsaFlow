// pages/api/auth/me.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { sql } from '@/lib/neon';
import { parseCookies, ACTIVE_COMPANY_COOKIE } from '@/lib/auth/cookies';

const handler: NextApiHandler = async (req, res) => {
  const user = (req as UserAuthedRequest).user;
  const activeCompanyId = parseCookies(req)[ACTIVE_COMPANY_COOKIE] ?? null;

  const profile = await sql<{
    id: string; email: string; first_name: string | null; last_name: string | null;
    role: string | null; permissions: unknown; onboarding_completed: boolean;
  }>`
    SELECT id, email, first_name, last_name, role, permissions, onboarding_completed
    FROM users
    WHERE id = ${user.id}
    LIMIT 1
  `;

  const memberships = await sql<{ company_id: string; role: string; is_default: boolean; name: string }>`
    SELECT cu.company_id, cu.role, cu.is_default, c.name
    FROM company_users cu
    JOIN companies c ON c.id = cu.company_id
    WHERE cu.user_id = ${user.id}
    ORDER BY cu.is_default DESC, cu.created_at ASC
  `;

  return res.status(200).json({
    success: true,
    data: {
      user: profile[0] ?? { id: user.id, email: user.email ?? '' },
      memberships,
      activeCompanyId,
    },
  });
};

export default withUserAuth(handler);
