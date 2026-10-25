/**
 * The one list of companies a session may be pointed at.
 *
 * `withAuth` admits a request only when `getCompanyMembership`
 * (`companyMembership.ts`) finds the membership AND the company is not
 * `status = 'deleted'`, not `status = 'suspended'` and not `suspended_at`.
 * Everything that CHOOSES a company for a session — login, the 2FA second leg,
 * ending an impersonation, accepting an invitation, the landing probe and the
 * company switcher's own list — has to use the same test, or it can hand the
 * browser an `active_company_id` cookie that every later request answers 403.
 *
 * Incident 2026-10-16: an admin soft-deleted a user's DEFAULT company
 * (`companies.status = 'deleted'`, `is_active` left true). Login still read the
 * default membership straight out of `company_users`, set the cookie to the
 * deleted company, and from then on every company-scoped call answered 403
 * 'Not a member of this company'. `CompanyContext` ended with no active company
 * and `/home` spun forever.
 *
 * `is_active = true` is kept from the previous `getUserCompanies` query. It is
 * STRICTER than withAuth, never looser, so nothing this module returns can be
 * refused by withAuth. Nothing in the app writes `companies.is_active = false`
 * (the admin soft delete writes `status`), so in practice it excludes nothing.
 *
 * Every relation is schema-qualified (S-07e): an unqualified name finds a
 * temporary table of the same name first.
 */
import { sql } from '@/lib/neon';

export interface LiveCompanyMembership {
  companyId: string;
  companyName: string;
  role: string;
  isDefault: boolean;
}

/**
 * Every membership of the user in a company a session may be scoped to,
 * default first then oldest first — the order every sign-in path picks from.
 */
export async function listLiveCompanyMemberships(userId: string): Promise<LiveCompanyMembership[]> {
  const rows = (await sql`
    SELECT cu.company_id, c.name AS company_name, cu.role, cu.is_default
    FROM public.company_users cu
    JOIN public.companies c ON c.id = cu.company_id
     AND c.is_active = true
     AND c.status IS DISTINCT FROM 'suspended'
     AND c.status IS DISTINCT FROM 'deleted'
     AND c.suspended_at IS NULL
    WHERE cu.user_id = ${userId}
    ORDER BY cu.is_default DESC, cu.created_at ASC
  `) as Record<string, unknown>[];
  return rows.map((r) => ({
    companyId: String(r.company_id),
    companyName: String(r.company_name ?? ''),
    role: String(r.role),
    isDefault: Boolean(r.is_default),
  }));
}

/**
 * The company a fresh session should be scoped to: the user's default when it
 * is still live, otherwise their oldest live membership, otherwise null (set
 * no cookie — the client lands on onboarding / "no company" rather than on a
 * cookie withAuth will refuse).
 */
export async function pickInitialCompanyId(userId: string): Promise<string | null> {
  const memberships = await listLiveCompanyMemberships(userId);
  return memberships[0]?.companyId ?? null;
}

/**
 * Is this company one a session may be scoped to, for this user? Used where a
 * company is NAMED (switch-company, impersonate-exchange, invitation accept)
 * rather than picked, so a named dead company is refused instead of becoming a
 * stuck session.
 */
export async function isLiveCompanyForUser(userId: string, companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS ok
    FROM public.company_users cu
    JOIN public.companies c ON c.id = cu.company_id
     AND c.is_active = true
     AND c.status IS DISTINCT FROM 'suspended'
     AND c.status IS DISTINCT FROM 'deleted'
     AND c.suspended_at IS NULL
    WHERE cu.user_id = ${userId} AND cu.company_id = ${companyId}::uuid
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0;
}

/**
 * The live companies among `companyIds`, with their names. For callers that
 * hold company ids from somewhere other than `company_users` — the AFS portal,
 * whose contacts are not members (audit S-08) — so they apply the same test.
 */
export async function listLiveCompanies(
  companyIds: readonly string[],
): Promise<Array<{ companyId: string; companyName: string }>> {
  if (companyIds.length === 0) return [];
  const rows = (await sql`
    SELECT c.id, c.name
    FROM public.companies c
    WHERE c.id = ANY(${[...companyIds]}::uuid[])
      AND c.is_active = true
      AND c.status IS DISTINCT FROM 'suspended'
      AND c.status IS DISTINCT FROM 'deleted'
      AND c.suspended_at IS NULL
  `) as Record<string, unknown>[];
  return rows.map((r) => ({ companyId: String(r.id), companyName: String(r.name ?? '') }));
}
