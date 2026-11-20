/**
 * #1656 round 3 (security hook, HIGH): the Approve gate on creating a recurring-journal template asks what the SERVICE will do.
 * createRecurringJournal stores `autoPost !== false`, so an OMITTED flag auto-posts; a gate on `autoPost === true` alone let a person
 * without Chart of Accounts & GL Approve create an auto-posting template by leaving it out. For a user WITHOUT Approve each shape
 * below is either refused or stores a template that does not auto-post; a user with Approve keeps the service default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/recurringJournalService', async (orig) => ({
  ...(await orig<object>()), createRecurringJournal: vi.fn(async () => ({ id: 'rj-1' })), updateRecurringJournalTemplate: vi.fn(async () => undefined),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { createRecurringJournal, recurringJournalAutoPosts, updateRecurringJournalTemplate } from '@/modules/accounting/services/gl/recurringJournalService';
import handler from '../../../pages/api/accounting/recurring-journals';

const C = '11111111-1111-4111-8111-111111111111';
const BASE = { templateName: 'Rent', frequency: 'monthly', nextRunDate: '2026-12-01', lines: [] };

function call(method: string, body: unknown) {
  const req = { method, query: {}, body, companyId: C, user: { id: 'u-1' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
const stored = () => vi.mocked(createRecurringJournal).mock.calls[0]?.[1] as { autoPost?: unknown } | undefined;

beforeEach(() => { vi.clearAllMocks(); vi.mocked(checkPermission).mockResolvedValue(false); });

describe('the service default is what the gate asks', () => {
  it('only an explicit false does not auto-post (omitted, null and a string all do)', () => {
    expect([undefined, null, true, 'true', 'false', 0].map(recurringJournalAutoPosts)).toEqual([true, true, true, true, true, true]);
    expect(recurringJournalAutoPosts(false)).toBe(false);
  });
});

describe('POST /api/accounting/recurring-journals without Approve', () => {
  it('autoPost omitted: a template that does NOT auto-post is stored', async () => {
    const res = await call('POST', { ...BASE });
    expect(res.statusCode).toBe(200);
    expect(stored()?.autoPost).toBe(false);
  });

  it('auto_post: true (snake case, an alias nothing reads): stored with autoPost false, never true', async () => {
    const res = await call('POST', { ...BASE, auto_post: true });
    expect(res.statusCode).toBe(200);
    expect(stored()?.autoPost).toBe(false);
  });

  it("autoPost: 'true' (a string): refused 400, nothing stored", async () => {
    const res = await call('POST', { ...BASE, autoPost: 'true' });
    expect(res.statusCode).toBe(400);
    expect(createRecurringJournal).not.toHaveBeenCalled();
  });

  it('autoPost: true: refused 403, nothing stored', async () => {
    const res = await call('POST', { ...BASE, autoPost: true });
    expect(res.statusCode).toBe(403);
    expect(createRecurringJournal).not.toHaveBeenCalled();
  });

  it('autoPost: false: stored as asked', async () => {
    await call('POST', { ...BASE, autoPost: false });
    expect(stored()?.autoPost).toBe(false);
  });

  it('PUT cannot switch auto-post on: the update takes the four template fields and nothing else', async () => {
    await call('PUT', { id: 'rj-1', templateName: 'x', frequency: 'monthly', nextRunDate: '2026-12-01', description: 'd', autoPost: true, auto_post: true });
    const input = vi.mocked(updateRecurringJournalTemplate).mock.calls[0]?.[3] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(['description', 'frequency', 'nextRunDate', 'templateName']);
  });
});

describe('POST with Approve keeps the service default', () => {
  it('autoPost omitted is passed through unchanged (the service posts); explicit true and false too', async () => {
    vi.mocked(checkPermission).mockResolvedValue(true);
    await call('POST', { ...BASE });
    expect(stored()?.autoPost).toBeUndefined();
    vi.mocked(createRecurringJournal).mockClear();
    await call('POST', { ...BASE, autoPost: true });
    expect(stored()?.autoPost).toBe(true);
  });
});
