/**
 * PR #1405 breaker rounds 6-7 (H1, M1): logAdminAction writes a UUID-shaped non-user target in lower case, so a view
 * matching target_id exactly finds the row. A 'user' target is written EXACTLY as given and never looked up: users.id
 * is TEXT, and after a delete a case-insensitive look-up picked the surviving case variant (round 7). Routes pass the
 * stored id (adminStoredUser; tests/unit/ci/adminUserAuditTargetCensus.test.ts pins that).
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
  it("a 'user' target is written exactly as given, even when a case variant is stored", async () => {
    h.storedUser = { id: 'CASEVAR-X', role: 'viewer' };
    await logAdminAction('admin', 'user.delete', 'user', 'casevar-x', null, null);
    expect(insertedTarget()).toBe('casevar-x');
    await logAdminAction('admin', 'user.update', 'user', UPPER, null, null);
    expect(insertedTarget()).toBe(UPPER); // a user's UUID-shaped TEXT id is not lower-cased either
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
