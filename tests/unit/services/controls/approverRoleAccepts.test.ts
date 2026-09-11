import { describe, expect, it } from 'vitest';
import { approverRoleAccepts } from '@/modules/accounting/services/controls/approvalQueries';

describe('approverRoleAccepts', () => {
  const roles = ['owner', 'admin', 'manager', 'viewer', null] as const;
  it.each([
    // The historical-import policy when the company admits owners: owner or admin.
    ['owner_or_admin', true, ['owner', 'admin']],
    // A tenant rule that merely says owner_or_admin is not mandatory: it admits nobody.
    ['owner_or_admin', false, []],
    // Every other policy, mandatory or not, is an exact role.
    ['admin', true, ['admin']],
    ['admin', false, ['admin']],
    ['manager', false, ['manager']],
    ['owner', true, ['owner']],
  ] as const)('%s (mandatory: %s) admits exactly %j', (approverRole, mandatory, admitted) => {
    for (const role of roles) expect(approverRoleAccepts({ approverRole, mandatory }, role)).toBe((admitted as readonly string[]).includes(role as string));
  });
  it('does not treat a truthy non-boolean mandatory as mandatory', () => {
    const forged = { approverRole: 'owner_or_admin', mandatory: 'true' as unknown as boolean };
    expect(approverRoleAccepts(forged, 'owner')).toBe(false);
    expect(approverRoleAccepts(forged, 'admin')).toBe(false);
  });
});
