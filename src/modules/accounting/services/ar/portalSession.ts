/**
 * The AR customer portal's session — ONE resolver for every route that reads
 * the `portal_session` cookie (statement, invoices, chat).
 *
 * The JWT alone is not the session. It is signed at login and valid for 24h,
 * so on its own it outlives everything that should end access: the portal
 * account being deactivated (`portal_access.is_active = false`) or removed,
 * and the customer being soft-deleted. Each request therefore re-checks that
 * an ACTIVE portal account still exists for the token's customer AND email,
 * and that the customer still belongs to the token's company, which is the
 * login's own (portal_access.company_id, written only on migration_admin,
 * 935: app roles can move a customer, not a login). A token that
 * fails any of these is refused exactly like a forged one: `null`, and the
 * caller answers 401.
 *
 * The claims are compared as TEXT, not cast to UUID: a claim that is not a
 * UUID then matches nothing, instead of raising a cast error that would reach
 * the customer as a 500.
 */

import type { NextApiRequest } from 'next';
// Named import: `cookie` is CJS with `__esModule` and no default export, so
// under Next's webpack interop `import cookie from 'cookie'` is undefined and
// every portal route 500'd (R-095). Vitest's interop hides this.
import { parse } from 'cookie';
import { sql, type DbRow } from '@/lib/neon';
import { verifyArPortalToken, type ArPortalSession } from '@/lib/auth/arPortalJwt';

export async function resolvePortalSession(req: NextApiRequest): Promise<ArPortalSession | null> {
  const token = parse(req.headers.cookie || '').portal_session;
  if (!token) return null;
  const session = await verifyArPortalToken(token);
  if (!session) return null;

  const rows = (await sql`
    SELECT 1
    FROM portal_access pa
    JOIN customers c ON c.id = pa.client_id
    WHERE pa.client_id::TEXT = ${session.clientId}
      AND pa.email = ${session.email}
      AND pa.is_active = true
      AND c.company_id::TEXT = ${session.companyId}
      AND pa.company_id = c.company_id
      AND c.deleted_at IS NULL
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0 ? session : null;
}
