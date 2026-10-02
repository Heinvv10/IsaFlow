/**
 * Guards for the company-group routes (company-groups.ts) beyond plain membership — D4 round 10
 * (security review of 5446d243c). Kept out of the route so it stays under the 300-line cap.
 *
 *  - Every id a request carries is UUID-checked (typeof first) before any `::UUID` cast.
 *  - A company whose chart is read into, or mapped within, a group must be a CURRENT member of
 *    that group, and copying / mapping its chart needs a write role in it — the same rule as
 *    putting the company into the group (companyAccessService.userCanWriteCompany).
 *  - A mapping's accounts must belong to that company and that group: the route used to accept
 *    any tenant's gl_accounts id and any group's group_accounts id, and GET mappings then
 *    returned the foreign account's code and name.
 *  - The creator's add-member bootstrap holds only while every current member company is one
 *    the creator still belongs to (vacuously, an empty group).
 *
 * `company_users.user_id` is TEXT: compared to the bare parameter, never cast (see
 * companyAccessService). `created_by` is uuid, so the COLUMN is cast to text.
 */

import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { userBelongsToCompany, userCanWriteCompany } from './companyAccessService';

type Fields = readonly string[];

/** Fields that, when present, must be UUIDs — per `METHOD action` (no action = ''). Query for GET/DELETE, body otherwise. */
const ID_FIELDS: Record<string, Fields> = {
  'GET *': ['group_id', 'company_id'],
  'POST add-member': ['groupId', 'companyId'],
  'POST create-group-account': ['groupId', 'parentAccountId'],
  'POST auto-generate-coa': ['groupId', 'sourceCompanyId'],
  'POST set-mapping': ['groupId', 'companyId', 'companyAccountId', 'groupAccountId'],
  'POST auto-map': ['groupId', 'companyId'],
  'POST ': ['holdingCompanyId'],
  'PUT update-member': ['memberId', 'groupId'],
  'PUT update-group-account': ['accountId', 'groupId', 'parentAccountId'],
  'PUT ': ['groupId', 'holdingCompanyId'],
  'DELETE remove-member': ['member_id', 'group_id'],
  'DELETE remove-mapping': ['mapping_id', 'group_id'],
  'DELETE delete-group-account': ['account_id', 'group_id'],
  'DELETE ': ['group_id'],
};

/**
 * The first id field that is present but not a UUID string, or null. Missing values are left to
 * the route's own "… required" checks, so those messages are unchanged.
 */
export function firstMalformedGroupId(
  method: string, action: string | undefined, query: Record<string, unknown>, body: unknown,
): string | null {
  const fields = method === 'GET' ? ID_FIELDS['GET *']! : ID_FIELDS[`${method} ${action ?? ''}`] ?? [];
  const src = method === 'GET' || method === 'DELETE'
    ? query
    : (body && typeof body === 'object' ? body as Record<string, unknown> : {});
  for (const f of fields) {
    const v = src[f];
    if (v !== undefined && v !== null && v !== '' && !isUuidParam(v)) return f;
  }
  return null;
}

/** True when the company is a CURRENT member of the group (`left_date IS NULL`). */
export async function companyIsGroupMember(groupId: string, companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM company_group_members
    WHERE group_id = ${groupId}::UUID AND company_id = ${companyId}::UUID AND left_date IS NULL
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0;
}

/**
 * The creator may add members without a group write role only while every current member company
 * is one they still belong to — an empty group, or only their own companies. Once a company they
 * do not belong to is in (or they left one), the group's own write roles decide.
 */
export async function creatorMayBootstrapGroup(userId: string, groupId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM company_groups g
    WHERE g.id = ${groupId}::UUID
      AND g.created_by::TEXT = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM company_group_members cgm
        WHERE cgm.group_id = g.id AND cgm.left_date IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM company_users cu WHERE cu.company_id = cgm.company_id AND cu.user_id = ${userId}
          )
      )
    LIMIT 1
  `) as Record<string, unknown>[];
  return rows.length > 0;
}

/** A gl_accounts id of THIS company, and a group_accounts id of THIS group. */
export async function mappingAccountsBelong(
  companyId: string, companyAccountId: string, groupId: string, groupAccountId: string,
): Promise<{ company: boolean; group: boolean }> {
  const rows = (await sql`
    SELECT
      EXISTS (SELECT 1 FROM gl_accounts WHERE id = ${companyAccountId}::UUID AND company_id = ${companyId}::UUID) AS company,
      EXISTS (SELECT 1 FROM group_accounts WHERE id = ${groupAccountId}::UUID AND group_id = ${groupId}::UUID) AS grp
  `) as Array<{ company: boolean; grp: boolean }>;
  return { company: rows[0]?.company === true, group: rows[0]?.grp === true };
}

export interface Refusal { status: 400 | 403; message: string }

/** Reading a company's mappings within a group: it must be a current member, and the caller in it. */
export async function refuseGroupCompanyRead(userId: string, groupId: string, companyId: string): Promise<Refusal | null> {
  if (!(await companyIsGroupMember(groupId, companyId))) return { status: 400, message: 'company_id is not a member of this group' };
  if (!(await userBelongsToCompany(userId, companyId))) return { status: 403, message: 'Access denied to the specified company' };
  return null;
}

/** Copying or mapping a company's chart within a group: a current member, and a write role in it. */
export async function refuseGroupCompanyWrite(userId: string, groupId: string, companyId: string): Promise<Refusal | null> {
  if (!(await companyIsGroupMember(groupId, companyId))) return { status: 400, message: 'The company is not a member of this group' };
  if (!(await userCanWriteCompany(userId, companyId))) {
    return { status: 403, message: "Changing a company's group chart or mappings needs an owner, admin or manager role in that company." };
  }
  return null;
}
