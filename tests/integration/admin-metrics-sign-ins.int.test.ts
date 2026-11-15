/**
 * The health page's sign-in widget and the dashboard's Recent Activity read
 * `users.last_login` (written on sign-in), not the dead `user_sessions` table
 * that nothing has written since the GoTrue cutover (admin audit 2.8 / WP8).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import healthRoute from '../../pages/api/admin/health';
import { getDashboardStats } from '@/modules/admin/services/adminDashboardService';
import { admin, callRoute, cleanup, ok, seed, seedSignedInUser, signedIn, tag } from './admin-metrics.helpers';

interface Health { users_signed_in_24h?: number | null }
const health = async () => ok<Health>(await callRoute(healthRoute, { sub: admin, method: 'GET' }));
let before: Health;

beforeAll(async () => {
  await seed();
  before = await health();
  await seedSignedInUser();
});
afterAll(cleanup);

describe('sign-ins come from users.last_login', () => {
  it('health counts a user who signed in an hour ago', async () => {
    const after = await health();
    expect((after.users_signed_in_24h ?? NaN) - (before.users_signed_in_24h ?? NaN)).toBe(1);
  });

  it('the dashboard lists that sign-in under Recent Activity', async () => {
    const { recent_activity } = await getDashboardStats();
    const login = recent_activity.find((e) => e.type === 'user_login' && e.id === signedIn);
    expect(login, JSON.stringify(recent_activity.slice(0, 5))).toBeDefined();
    expect(login!.user_name).toBe(`Wp8 ${tag}`);
    expect(Date.now() - new Date(login!.created_at).getTime()).toBeGreaterThan(55 * 60_000);
  });
});
