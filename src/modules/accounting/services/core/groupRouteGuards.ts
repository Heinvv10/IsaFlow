/**
 * Guards for the company-group routes (company-groups.ts) beyond plain membership — D4 round 10
 * (security review of 5446d243c). Kept out of the route so it stays under the 300-line cap.
 *
 *  - Every id a request carries is UUID-checked (typeof first) before any `::UUID` cast, and an
 *    unknown action is refused on every method (round 11).
 *  - A company whose chart is read into, or mapped within, a group must be a CURRENT member of
 *    that group, and copying / mapping its chart needs a write role in it — the same rule as
 *    putting the company into the group (companyAccessService.userCanWriteCompany).
 *  - A mapping's accounts must belong to that company and that group: the route used to accept
 *    any tenant's gl_accounts id and any group's group_accounts id, and GET mappings then
 *    returned the foreign account's code and name.
 *  - The creator's add-member bootstrap holds only while the group has no current member.
 *
 * `company_users.user_id` is TEXT: compared to the bare parameter, never cast (see
 * companyAccessService). `created_by` is uuid, so the COLUMN is cast to text.
 */

import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { userBelongsToCompany, userCanWriteCompany } from './companyAccessService';

/** Every action the route knows, per method ('' = no action). Anything else is refused, never fallen through. */
const ACTIONS: Record<string, readonly string[]> = {
  GET: ['', 'members', 'accounts', 'mappings', 'unmapped'],
  POST: ['', 'add-member', 'create-group-account', 'auto-generate-coa', 'set-mapping', 'auto-map'],
  PUT: ['', 'update-member', 'update-group-account'],
  DELETE: ['', 'remove-member', 'remove-mapping', 'delete-group-account'],
};

/** Every id a request may carry, in the query or the body, whatever the action. */
const ID_FIELDS = [
  'group_id', 'company_id', 'member_id', 'mapping_id', 'account_id',
  'groupId', 'companyId', 'sourceCompanyId', 'companyAccountId', 'groupAccountId',
  'parentAccountId', 'holdingCompanyId', 'memberId', 'accountId',
] as const;

/**
 * 400 text for a request the route must not act on, or null:
 *  - an action it does not know (or a non-string one). DELETE had no such check, so
 *    `DELETE ?action=foo&group_id=…` fell through to delete-group;
 *  - an id that is present but not a UUID string, checked for EVERY id field regardless of the
 *    action, so no branch can reach a `::UUID` cast with a malformed or repeated value.
 * Missing ids are left to the route's own "… required" checks, so those messages are unchanged.
 */
export function groupRequestError(
  method: string, rawAction: unknown, query: Record<string, unknown>, body: unknown,
): string | null {
  if (rawAction !== undefined && rawAction !== '' && typeof rawAction !== 'string') return 'action must be a string';
  const action = typeof rawAction === 'string' ? rawAction : '';
  const known = ACTIONS[method];
  if (known && !known.includes(action)) return `Unknown action: ${action}`;
  const bodyObj = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  for (const src of [query, bodyObj]) {
    for (const f of ID_FIELDS) {
      const v = src[f];
      if (v !== undefined && v !== null && v !== '' && !isUuidParam(v)) return `${f} must be a valid UUID`;
    }
  }
  return null;
}

/** The company a mapping of THIS group belongs to, or null when there is no such mapping. */
export async function mappingCompanyId(mappingId: string, groupId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT company_id FROM group_coa_mappings WHERE id = ${mappingId}::UUID AND group_id = ${groupId}::UUID LIMIT 1
  `) as Array<{ company_id: unknown }>;
  return rows[0] ? String(rows[0].company_id) : null;
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
 * The creator may add a member without a group write role only while the group has NO current
 * member — it could never gain its first one otherwise. Once any company is in, the group's own
 * write roles decide: a creator demoted to viewer (or who has left) keeps no standing write.
 */
export async function creatorMayBootstrapGroup(userId: string, groupId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM company_groups g
    WHERE g.id = ${groupId}::UUID
      AND g.created_by::TEXT = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM company_group_members cgm WHERE cgm.group_id = g.id AND cgm.left_date IS NULL
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

export const COMPANY_CHART_REFUSED =
  "Changing a company's group chart or mappings needs an owner, admin or manager role in that company.";

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
    return { status: 403, message: COMPANY_CHART_REFUSED };
  }
  return null;
}
