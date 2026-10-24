/**
 * Bureau service — read/write helpers for bureaus, bureau_companies, bureau_users.
 *
 * Used by:
 *   • Admin: convertUserToBureauOwner() — manual conversion of an existing user.
 *   • /bureau/* pages: listBureausForUser(), listBureauCompanies().
 *
 * No company_id scoping (bureaus are user-scoped, not tenant-scoped). Callers
 * must enforce that the calling user is a member of the bureau before reading.
 * Writes: no app role may write bureaus, bureau_users or bureau_companies
 * (migration 932). createBureauForOwner runs on the admin convert route's
 * platform_admin transaction; client links and the sharing consent run on the
 * migration_admin pool (bureauCompanyLinkService, bureauSettingsService).
 */

import { sql } from '@/lib/neon';
import type { CompanyMeta } from './bureauWorkTypes';

export type BureauRole = 'owner' | 'accountant' | 'viewer';
export type AccountType = 'direct' | 'bureau_owner' | 'bureau_member';

export interface Bureau {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface BureauCompanyRow {
  bureauId: string;
  companyId: string;
  companyName: string;
  addedAt: Date | string;
}

export interface BureauMember {
  bureauId: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: BureauRole;
  addedAt: Date | string;
}

interface RawBureau {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToBureau(r: RawBureau): Bureau {
  return {
    id: r.id,
    name: r.name,
    ownerUserId: r.owner_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Create a new bureau and set the user as its owner.
 * Also flips users.account_type → 'bureau_owner' if currently 'direct'.
 * Returns the new bureau.
 */
export async function createBureauForOwner(opts: {
  name: string;
  ownerUserId: string;
}): Promise<Bureau> {
  const inserted = (await sql`
    INSERT INTO bureaus (name, owner_user_id)
    VALUES (${opts.name}, ${opts.ownerUserId})
    RETURNING id, name, owner_user_id, created_at, updated_at
  `) as unknown as RawBureau[];
  const bureau = rowToBureau(inserted[0]!);

  await sql`
    INSERT INTO bureau_users (bureau_id, user_id, role)
    VALUES (${bureau.id}, ${opts.ownerUserId}, 'owner')
    ON CONFLICT (bureau_id, user_id) DO NOTHING
  `;

  await sql`
    UPDATE users SET account_type = 'bureau_owner'
     WHERE id = ${opts.ownerUserId} AND account_type = 'direct'
  `;

  return bureau;
}

/**
 * Convert an existing 'direct' user into a bureau owner. Idempotent — if the
 * user already owns a bureau with this name, returns the existing one.
 */
export async function convertUserToBureauOwner(opts: {
  userId: string;
  bureauName: string;
}): Promise<Bureau> {
  const existing = (await sql`
    SELECT id, name, owner_user_id, created_at, updated_at
      FROM bureaus
     WHERE owner_user_id = ${opts.userId} AND name = ${opts.bureauName}
     LIMIT 1
  `) as unknown as RawBureau[];

  if (existing.length > 0) return rowToBureau(existing[0]!);

  return createBureauForOwner({ name: opts.bureauName, ownerUserId: opts.userId });
}

/** Returns every bureau the user is a member of (including ones they own). */
export async function listBureausForUser(userId: string): Promise<Array<Bureau & { role: BureauRole }>> {
  const rows = (await sql`
    SELECT b.id, b.name, b.owner_user_id, b.created_at, b.updated_at, bu.role
      FROM bureau_users bu
      JOIN bureaus b ON b.id = bu.bureau_id
     WHERE bu.user_id = ${userId}
     ORDER BY b.name
  `) as unknown as Array<RawBureau & { role: BureauRole }>;

  return rows.map((r) => ({ ...rowToBureau(r), role: r.role }));
}

/** Companies managed by a bureau. Caller must check the user belongs to the bureau first. */
export async function listBureauCompanies(bureauId: string): Promise<BureauCompanyRow[]> {
  const rows = (await sql`
    SELECT bc.bureau_id, bc.company_id, c.name AS company_name, bc.added_at
      FROM bureau_companies bc
      JOIN companies c ON c.id = bc.company_id
     WHERE bc.bureau_id = ${bureauId}
     ORDER BY c.name
  `) as unknown as Array<{
    bureau_id: string;
    company_id: string;
    company_name: string;
    added_at: Date | string;
  }>;

  return rows.map((r) => ({
    bureauId: r.bureau_id,
    companyId: r.company_id,
    companyName: r.company_name,
    addedAt: r.added_at,
  }));
}

export { linkCompanyToBureau, unlinkCompanyFromBureau } from './bureauCompanyLinkService';

/** Members of a bureau, joined with user names/emails. */
export async function listBureauMembers(bureauId: string): Promise<BureauMember[]> {
  const rows = (await sql`
    SELECT bu.bureau_id, bu.user_id, u.email, u.first_name, u.last_name, bu.role, bu.added_at
      FROM bureau_users bu
      JOIN users u ON u.id = bu.user_id
     WHERE bu.bureau_id = ${bureauId}
     ORDER BY u.email
  `) as unknown as Array<{
    bureau_id: string;
    user_id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    role: BureauRole;
    added_at: Date | string;
  }>;

  return rows.map((r) => ({
    bureauId: r.bureau_id,
    userId: r.user_id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    role: r.role,
    addedAt: r.added_at,
  }));
}

/**
 * The caller's role in the bureau, or null when not a member. OWNER means bureaus.owner_user_id — the one
 * owner column: NOT NULL, set by createBureauForOwner (which also writes the bureau_users 'owner' row), and
 * what every owner-only check reads (clients, company links, sharing). Nothing in the app transfers a
 * bureau or adds a second owner, so a bureau_users 'owner' row for anyone else is stale (say, a hand-made
 * transfer that moved owner_user_id only): it reads as 'accountant', never as owner, and the owner keeps
 * owner rights even with their bureau_users row missing.
 */
export async function getBureauRole(userId: string, bureauId: string): Promise<BureauRole | null> {
  const rows = (await sql`
    SELECT CASE WHEN b.owner_user_id = ${userId} THEN 'owner'
                WHEN bu.role = 'owner' THEN 'accountant'
                ELSE bu.role END AS role
      FROM bureaus b
      LEFT JOIN bureau_users bu ON bu.bureau_id = b.id AND bu.user_id = ${userId}
     WHERE b.id = ${bureauId}::UUID AND (b.owner_user_id = ${userId} OR bu.user_id IS NOT NULL)
     LIMIT 1
  `) as unknown as Array<{ role: BureauRole }>;
  return rows[0]?.role ?? null;
}

/** True if the user is a member of the bureau (any role, the owner included). */
export async function userIsBureauMember(userId: string, bureauId: string): Promise<boolean> {
  return (await getBureauRole(userId, bureauId)) !== null;
}

/**
 * Tenant gate for the client home. Re-derives the caller's bureau companies
 * server-side and returns the CompanyMeta for `companyId` ONLY if it is in
 * that set — otherwise null. Never trust a companyId from the URL; pass it
 * through here first. (Same authorization boundary as /api/bureau.)
 */
export async function getBureauClientForUser(
  userId: string,
  companyId: string,
): Promise<CompanyMeta | null> {
  const bureaus = await listBureausForUser(userId);
  if (bureaus.length === 0) return null;
  const bureauIds = bureaus.map((b) => b.id);
  const rows = (await sql`
    SELECT bc.bureau_id, b.name AS bureau_name, bc.company_id, c.name AS company_name
      FROM bureau_companies bc
      JOIN bureaus b ON b.id = bc.bureau_id
      JOIN companies c ON c.id = bc.company_id
     WHERE bc.bureau_id = ANY(${bureauIds}) AND bc.company_id = ${companyId}
     ORDER BY b.name, bc.bureau_id
     LIMIT 1
  `) as unknown as CompanyMeta[];
  return rows[0] ?? null;
}
