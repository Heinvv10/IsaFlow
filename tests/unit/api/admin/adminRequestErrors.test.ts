/**
 * PR #1405 review round (WP14b): the refusal helpers map only what they were written for.
 *   - isPgError matches the SQLSTATE AND the named constraint (L1): another constraint's violation stays a 500;
 *   - users/[id]/impersonate maps only its own refusal codes (L4): an error whose message is an Object.prototype
 *     name ("toString", "constructor") used to read the prototype's function as a status and crash the answer;
 *   - withAdminRefusals refuses a repeated or NUL-carrying query parameter with a 400 before the route runs (B3/B4).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/admin/middleware/withAdmin', async () => {
  const { withAdminRefusals } = await import('@/modules/admin/middleware/adminRequestErrors');
  return { withAdmin: (h: Parameters<typeof withAdminRefusals>[0]) => withAdminRefusals(h) };
});
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
const validateImpersonationTarget = vi.hoisted(() => vi.fn());
vi.mock('@/modules/admin/services/userImpersonationService', () => ({
  validateImpersonationTarget, stashAdminTokens: vi.fn(), deleteStash: vi.fn(), loadStash: vi.fn(),
}));

import { isPgError, withAdminRefusals } from '@/modules/admin/middleware/adminRequestErrors';
import impersonateRoute from '../../../../pages/api/admin/users/[id]/impersonate';
import { callRoute } from '../../helpers/adminRouteCall';

describe('isPgError', () => {
  const fk = { code: '23503', constraint: 'subscriptions_plan_id_fkey' };
  it('matches the SQLSTATE on a named constraint', () => {
    expect(isPgError(fk, '23503', 'subscriptions_plan_id_fkey')).toBe(true);
    expect(isPgError(fk, '23503', ['subscriptions_company_id_fkey', 'subscriptions_plan_id_fkey'])).toBe(true);
  });
  it('does not match another constraint, another SQLSTATE, or an error without a constraint', () => {
    expect(isPgError(fk, '23503', 'subscriptions_company_id_fkey')).toBe(false);
    expect(isPgError(fk, '23505', 'subscriptions_plan_id_fkey')).toBe(false);
    expect(isPgError({ code: '23503' }, '23503', 'subscriptions_plan_id_fkey')).toBe(false);
    expect(isPgError(null, '23503', 'subscriptions_plan_id_fkey')).toBe(false);
  });
});

describe('users/[id]/impersonate refusal map', () => {
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])('an error "%s" is rethrown (500), not answered', async (message) => {
    validateImpersonationTarget.mockRejectedValueOnce(new Error(message));
    await expect(callRoute(impersonateRoute, 'POST', { id: 'target-user' })).rejects.toThrow(message);
  });
  it('its own refusal is still its 4xx', async () => {
    validateImpersonationTarget.mockRejectedValueOnce(new Error('CANNOT_IMPERSONATE_SUPER_ADMIN'));
    expect((await callRoute(impersonateRoute, 'POST', { id: 'target-user' })).statusCode).toBe(403);
  });
});

describe('withAdminRefusals query guard', () => {
  const route = withAdminRefusals(vi.fn(async () => undefined));
  it.each([
    [{ page: ['1', '2'] }, /page must be given once/],
    [{ search: 'a\u0000b' }, /search must not contain a NUL character/],
  ])('%j is a 400 before the route runs', async (query, message) => {
    const r = await callRoute(route, 'GET', query);
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(message);
  });
  it('a clean query reaches the route', async () => {
    const inner = vi.fn(async () => undefined);
    await callRoute(withAdminRefusals(inner), 'GET', { page: '1', search: 'abc' });
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
