/**
 * GRP-03 (second half) — listGroupsForUser leaked groups to departed members.
 *
 * `userBelongsToGroup` now filters `cgm.left_date IS NULL`, but the group LIST
 * query joined company_group_members with no such predicate. A user whose company
 * had left the group therefore still saw the group — its name, its holding
 * company's name and its member count — in their list, then got 403 on opening
 * it. Same rule, applied in only one of the two places is worse than neither.
 *
 * The sql mock emulates the predicate rather than asserting on SQL text: it holds
 * one group row reachable ONLY through a departed membership, and returns it
 * unless the query joins on `cgm.left_date IS NULL`. Note the unfixed query
 * already mentions `cgm2.left_date IS NULL` in the member-count FILTER, so the
 * marker below is deliberately the `cgm.` alias — matching a bare "left_date IS
 * NULL" would have passed against the broken query and proved nothing.
 *
 * Mutation check: remove the predicate from the cgm join and the first test goes
 * red (the group is listed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { listGroupsForUser } from '@/modules/accounting/services/reports/groupCrudService';

const USER = 'user-1';

/** The join predicate that excludes retired membership rows. */
const ACTIVE_MEMBER_JOIN = 'cgm.left_date IS NULL';

/**
 * Strip `--` comments before matching, exactly as Postgres does.
 *
 * Without this the test was worthless: the fix ships an explanatory SQL comment
 * that itself contains the marker string, so deleting the real predicate left the
 * mock still matching the comment and the suite stayed green. The mutation run
 * caught it — matching raw SQL text means matching text that has no effect on
 * the query.
 */
function normaliseSql(strings: readonly string[]): string {
  return strings.join('?').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
}

const GROUP_ROW = {
  id: 'group-1',
  name: 'Departed Group',
  holding_company_name: 'Some Holding Co',
  member_count: 2,
  is_active: true,
};

/**
 * `membershipLeft` models the caller's only company_group_members row having a
 * non-null left_date: Postgres drops it once the join filters on left_date, so
 * the group becomes unreachable and the row disappears from the result.
 */
function installSql(opts: { membershipLeft: boolean }) {
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = normaliseSql(strings);
    if (!q.includes('FROM company_groups')) return [];
    if (opts.membershipLeft && q.includes(ACTIVE_MEMBER_JOIN)) return [];
    return [GROUP_ROW];
  });
}

beforeEach(() => vi.clearAllMocks());

describe('listGroupsForUser — departed members must not see the group', () => {
  it('omits a group the caller only reaches through a retired membership', async () => {
    installSql({ membershipLeft: true });

    const groups = await listGroupsForUser(USER);

    expect(groups).toHaveLength(0);
  });

  it('still lists a group the caller reaches through an active membership', async () => {
    installSql({ membershipLeft: false });

    const groups = await listGroupsForUser(USER);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe('Departed Group');
  });

  it('keeps the member count filtered on left_date independently of the join', async () => {
    installSql({ membershipLeft: false });

    await listGroupsForUser(USER);

    const q = normaliseSql(sqlMock.mock.calls[0]![0] as string[]);
    // The visibility join and the member-count FILTER are separate concerns:
    // narrowing the join must not be mistaken for having fixed the count.
    expect(q).toContain('FILTER (WHERE cgm2.left_date IS NULL)');
    expect(q).toContain(ACTIVE_MEMBER_JOIN);
  });
});
