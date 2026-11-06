// The "Keep me signed in" cookie is HttpOnly, so /api/auth/me is how the heartbeat learns the choice. Anything but an
// explicit tick answers false: the stricter idle rule applies.
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/withUserAuth', () => ({ withUserAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/liveCompanies', () => ({ listLiveCompanyMemberships: async () => [] }));
const profile = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/neon', () => ({ sql: async () => profile.rows }));

import handler from '../../../../pages/api/auth/me';

async function me(cookie: string) {
  let body: { data: { user: { rememberMe: unknown } } } | undefined;
  const res = { status() { return res; }, json(b: typeof body) { body = b; return res; } } as unknown as NextApiResponse;
  const req = { headers: { cookie }, user: { id: 'u-1', email: 'u@example.test' } } as unknown as NextApiRequest;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  return body!.data.user.rememberMe;
}

describe.each([
  ['with a profile row', [{ id: 'u-1', email: 'u@example.test', onboarding_completed: true }]],
  ['before provisioning', []],
])('/api/auth/me %s', (_label, rows) => {
  it.each([
    ['ticked', 'isaflow_remember_me=1', true],
    ['unticked', 'isaflow_remember_me=0', false],
    ['no cookie', 'other=1', false],
  ])('%s', async (_case, cookie, expected) => {
    profile.rows = rows;
    expect(await me(cookie)).toBe(expected);
  });
});
