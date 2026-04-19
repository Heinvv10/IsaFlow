// tests/integration/admin-password-reset.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { resetPassword } from '@/modules/admin/services/adminUserActionsService';

const MIGRATION_ADMIN_DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL;
if (!MIGRATION_ADMIN_DATABASE_URL) throw new Error('MIGRATION_ADMIN_DATABASE_URL required');

const seedPool = new Pool({ connectionString: MIGRATION_ADMIN_DATABASE_URL, max: 1 });
const TARGET_EMAIL = `reset-target-${Date.now()}@test.local`;
const PW = 'ResetTest!Secret123';

describe('admin password reset - GoTrue recovery link (integration)', () => {
  let targetId: string;

  beforeAll(async () => {
    const t = await adminCreateUser({ email: TARGET_EMAIL, password: PW, email_confirm: true });
    targetId = t.id;
    await seedPool.query(
      `INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)
         ON CONFLICT (id) DO UPDATE SET role = 'viewer'`,
      [targetId, TARGET_EMAIL]
    );
  });

  afterAll(async () => {
    await seedPool.query(`DELETE FROM users WHERE id = $1`, [targetId]);
    try { await adminDeleteUser(targetId); } catch { /* best-effort */ }
    await seedPool.end();
  });

  it('resetPassword returns a GoTrue recovery action_link', async () => {
    const result = await resetPassword(targetId);
    expect(result.reset_link).toMatch(/\/auth\/v1\/verify\?.*type=recovery/);
  });

  it('refuses to reset a super_admin', async () => {
    const adminEmail = `reset-admin-${Date.now()}@test.local`;
    const adminUser = await adminCreateUser({ email: adminEmail, password: PW, email_confirm: true });
    try {
      await seedPool.query(
        `INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)
           ON CONFLICT (id) DO UPDATE SET role = 'super_admin'`,
        [adminUser.id, adminEmail]
      );
      await expect(resetPassword(adminUser.id)).rejects.toThrow(/CANNOT_RESET_SUPER_ADMIN/);
    } finally {
      await seedPool.query(`DELETE FROM users WHERE id = $1`, [adminUser.id]);
      try { await adminDeleteUser(adminUser.id); } catch { /* best-effort */ }
    }
  });
});
