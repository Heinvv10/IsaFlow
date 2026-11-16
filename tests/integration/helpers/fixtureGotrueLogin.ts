/**
 * A stand-in for `@/lib/auth/gotrueAdminUser` in suites whose fixture has no GoTrue (GOTRUE_URL points nowhere).
 *
 * POST /api/invite/<token> compares the invitation to the session user's CURRENT GoTrue login email, read through
 * adminGetUser, not to the session's email claim (#1468 re-break F1: the claim is stale for up to an hour after
 * change-email). These suites mint sessions whose email claim follows a fixed convention; answering that same
 * address keeps the route judging what it judged from the claim before. An id `emailOf` has no address for is
 * GoTrue's 404 (null). Use in a vi.mock factory:
 *   vi.mock('@/lib/auth/gotrueAdminUser', async () =>
 *     (await import('./helpers/fixtureGotrueLogin')).fixtureGotrueLogin((id) => `${id}@test.local`));
 */
export function fixtureGotrueLogin(emailOf: (id: string) => string | undefined) {
  return {
    adminGetUser: async (id: string) => {
      const email = emailOf(id);
      return email === undefined ? null : { id, email };
    },
  };
}
