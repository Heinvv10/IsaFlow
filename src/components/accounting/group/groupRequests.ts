/**
 * Request-body builders for /api/accounting/company-groups.
 *
 * Why this module exists: every group-setup UI call site hand-wrote its own
 * object literal in snake_case, while every route action destructures camelCase.
 * The result was a surface where nothing worked — add-member, update-member,
 * set-mapping, auto-map and auto-generate-coa all 400'd; create-group silently
 * dropped the holding company (leaving the new group with no members); and two
 * call sites used action names that do not exist, one of which fell through to
 * the create-group branch and made a company group named after a GL account.
 *
 * None of it was visible to tsc or eslint: the bodies were literals inside
 * JSON.stringify.
 *
 * Both the UI and `tests/unit/api/groupSetupRequestShapes.test.ts` build their
 * bodies here, so the test drives the SAME payload the UI sends. A test holding
 * its own copy of the shape would keep passing after the UI drifted — which is
 * precisely how this class of bug survived.
 *
 * Action names are typed, so a non-existent action is now a compile error.
 */

/** POST actions the route implements. */
export type GroupPostAction =
  | 'add-member'
  | 'create-group-account'
  | 'auto-generate-coa'
  | 'set-mapping'
  | 'auto-map';

/** PUT actions the route implements. */
export type GroupPutAction = 'update-member' | 'update-group-account';

export interface MemberForm {
  companyId: string;
  ownershipPct: number;
  consolidationMethod: string;
}

export interface GroupAccountForm {
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string;
  level: number;
}

/** POST (no action) — create a group. */
export function createGroupBody(form: {
  name: string;
  holdingCompanyId: string;
  defaultCurrency: string;
  financialYearStart: number;
}) {
  return { ...form };
}

export function addMemberBody(groupId: string, form: MemberForm) {
  return { action: 'add-member' as const, groupId, ...form };
}

export function updateMemberBody(
  groupId: string,
  memberId: string,
  form: Omit<MemberForm, 'companyId'>,
) {
  return { action: 'update-member' as const, memberId, groupId, ...form };
}

export function autoGenerateCoaBody(groupId: string, sourceCompanyId: string) {
  return { action: 'auto-generate-coa' as const, groupId, sourceCompanyId };
}

export function createGroupAccountBody(groupId: string, form: GroupAccountForm) {
  return { action: 'create-group-account' as const, groupId, ...form };
}

export function updateGroupAccountBody(groupId: string, accountId: string, accountName: string) {
  return { action: 'update-group-account' as const, accountId, groupId, accountName };
}

export function setMappingBody(
  groupId: string,
  companyId: string,
  companyAccountId: string,
  groupAccountId: string | null,
) {
  return { action: 'set-mapping' as const, groupId, companyId, companyAccountId, groupAccountId };
}

export function autoMapBody(groupId: string, companyId: string) {
  return { action: 'auto-map' as const, groupId, companyId };
}

/**
 * DELETE uses snake_case QUERY parameters, not a camelCase body — the route
 * reads `req.query.member_id` / `req.query.group_id`. Built here so the two
 * conventions cannot be confused at a call site.
 */
export function removeMemberQuery(groupId: string, memberId: string): string {
  const p = new URLSearchParams({ action: 'remove-member', member_id: memberId, group_id: groupId });
  return `/api/accounting/company-groups?${p.toString()}`;
}
