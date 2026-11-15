/**
 * PR #1405 breaker round 6 (H1): logAdminAction writes target_id in its canonical spelling, so a view matching it
 * exactly finds the row: a 'user' target is the stored users.id (findStoredUser: exact match, else case-insensitive;
 * the given value when no row exists), any other UUID-shaped target is lower case, anything else is kept.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ storedUser: null as null | { id: string; role: string }, inserted: [] as unknown[][] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/FROM users WHERE lower\(id\)/.test(text)) return h.storedUser ? [h.storedUser] : [];
    if (/INSERT INTO admin_audit_log/.test(text)) h.inserted.push(values);
    return [];
  }),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

import { logAdminAction } from '@/modules/admin/services/auditService';

/** The target_id the INSERT bound (its 4th value: admin, action, type, target, ...). */
const insertedTarget = () => h.inserted.at(-1)?.[3];
const UPPER = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

beforeEach(() => { h.storedUser = null; h.inserted = []; });

describe('logAdminAction: canonical target_id', () => {
  it("a 'user' target is the stored users.id", async () => {
    h.storedUser = { id: 'MixedCase-1', role: 'viewer' };
    await logAdminAction('admin', 'user.x', 'user', 'mixedcase-1', null, null);
    expect(insertedTarget()).toBe('MixedCase-1');
  });

  it("a 'user' target with no stored row keeps the given value (e.g. after a delete)", async () => {
    await logAdminAction('admin', 'user.delete', 'user', 'Gone-User', null, null);
    expect(insertedTarget()).toBe('Gone-User');
  });

  it('any other UUID-shaped target is lower case', async () => {
    await logAdminAction('admin', 'company.update', 'company', UPPER, null, null);
    expect(insertedTarget()).toBe(UPPER.toLowerCase());
  });

  it('a non-UUID target of another type is kept as given; null stays null', async () => {
    await logAdminAction('admin', 'sars_codes.import', 'sars_code_release', '2026', null, null);
    expect(insertedTarget()).toBe('2026');
    await logAdminAction('admin', 'job.bulk_retry', 'background_job', null, null, null);
    expect(insertedTarget()).toBeNull();
  });
});
