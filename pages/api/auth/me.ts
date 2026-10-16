// pages/api/auth/me.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { sql } from '@/lib/neon';
import { parseCookies, ACTIVE_COMPANY_COOKIE } from '@/lib/auth/cookies';
import { listLiveCompanyMemberships } from '@/lib/auth/liveCompanies';

const handler: NextApiHandler = async (req, res) => {
  const user = (req as UserAuthedRequest).user;
  const activeCompanyId = parseCookies(req)[ACTIVE_COMPANY_COOKIE] ?? null;

  const profile = await sql<{
    id: string; email: string; first_name: string | null; last_name: string | null;
    role: string | null; permissions: unknown; onboarding_completed: boolean | null;
  }>`
    SELECT id, email, first_name, last_name, role, permissions, onboarding_completed
    FROM users
    WHERE id = ${user.id}
    LIMIT 1
  `;

  // Only companies a session may actually be scoped to. Unfiltered, this list
  // advertised admin-soft-deleted companies that withAuth then refused, and it
  // is what CompanyContext falls back to when the company-scoped
  // user-companies call 403s — recovery has to be offered a live target.
  // Shape is kept snake_case for existing consumers.
  const live = await listLiveCompanyMemberships(user.id);
  const memberships = live.map((m) => ({
    company_id: m.companyId,
    role: m.role,
    is_default: m.isDefault,
    name: m.companyName,
  }));

  const profileRow = profile[0] ?? null;
  return res.status(200).json({
    success: true,
    data: {
      user: profileRow
        ? {
            ...profileRow,
            onboarding_completed: profileRow.onboarding_completed ?? null,
          }
        : { id: user.id, email: user.email ?? '', onboarding_completed: null },
      memberships,
      activeCompanyId,
    },
  });
};

export default withUserAuth(handler);
