/**
 * The Companies list sort column comes from an allowlist of OWN keys (WP13 review L3): sort_by=constructor (or any
 * Object.prototype name) is 400 before any SQL runs. With a plain `ALLOWED[key]` lookup it passed the check and
 * reached sql.unsafe().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const fx = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/neon', () => {
  const sql = Object.assign(vi.fn(async () => { fx.calls += 1; return [{ total: '0' }]; }), { unsafe: vi.fn(() => '') });
  return { sql };
});

import route from '../../../../pages/api/admin/companies';
import { callRoute } from '../../helpers/adminRouteCall';

beforeEach(() => { fx.calls = 0; });

describe('GET /api/admin/companies sort_by', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope'])('%s is 400 and runs no SQL', async (key) => {
    const r = await callRoute(route, 'GET', { sort_by: key });
    expect(r.statusCode).toBe(400);
    expect(fx.calls).toBe(0);
  });

  it.each(['plan_name', 'last_active', 'name'])('%s is accepted', async (key) => {
    const r = await callRoute(route, 'GET', { sort_by: key });
    expect(r.statusCode).toBe(200);
  });
});
