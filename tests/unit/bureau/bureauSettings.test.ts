/**
 * Bureau merchant-pattern sharing: owner-only toggle, one audit row per real change, and the route's auth.
 * The owner check is a JOIN on bureau_users.role = 'owner' inside the write transaction; here the
 * transaction is simulated (a non-owner's lock query returns no row), and the real join runs against a
 * schema in tests/integration/bureau-audit-log-rls.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { sqlMock, txMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), txMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: async (fn: (tx: typeof txMock) => unknown) => fn(txMock),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/withUserAuth', () => ({
  withUserAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import { setBureauSharingSetting } from '@/modules/bureau/services/bureauSettingsService';
import handler from '../../../pages/api/bureau/settings';

const BUREAU = '00000000-0000-4000-8000-0000000000b1';
const OWNER = 'user-owner';

const txText = (i: number) => (txMock.mock.calls[i]![0] as TemplateStringsArray).join('?');

/** The lock query answers as Postgres would: a row only for the bureau owner. */
function bureauRoles(roles: Record<string, 'owner' | 'accountant' | 'viewer'>, current: boolean) {
  txMock.mockImplementation(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?');
    if (/FOR UPDATE OF b/.test(text)) {
      const user = vals[0] as string;
      return roles[user] === 'owner' ? [{ share_merchant_patterns: current }] : [];
    }
    return [];
  });
  sqlMock.mockImplementation(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?');
    if (/FROM bureau_users WHERE bureau_id/.test(text)) {
      const role = roles[vals[1] as string];
      return role ? [{ role }] : [];
    }
    if (/SELECT share_merchant_patterns FROM bureaus/.test(text)) return [{ share_merchant_patterns: current }];
    return [];
  });
}

function res() {
  const r = { statusCode: 200, body: undefined as unknown,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
const call = async (method: string, userId: string, opts: { body?: unknown; query?: Record<string, string> } = {}) => {
  const out = res();
  await (handler as unknown as (q: unknown, s: unknown) => Promise<unknown>)(
    { method, user: { id: userId }, body: opts.body, query: opts.query ?? {}, headers: {} }, out);
  return out;
};

beforeEach(() => { sqlMock.mockReset(); txMock.mockReset(); });

describe('setBureauSharingSetting', () => {
  it('owner switching it on: updates the bureau and writes one audit row, old -> new', async () => {
    bureauRoles({ [OWNER]: 'owner' }, false);
    expect(await setBureauSharingSetting({ bureauId: BUREAU, actorUserId: OWNER, value: true }))
      .toEqual({ kind: 'ok', changed: true, oldValue: false, newValue: true });
    expect(txText(0)).toMatch(/bu\.role = 'owner'/);
    expect(txText(1)).toMatch(/UPDATE bureaus SET share_merchant_patterns/);
    expect(txText(2)).toMatch(/INSERT INTO bureau_audit_log/);
    expect(txMock.mock.calls[2]!.slice(1)).toEqual([BUREAU, OWNER, false, true]);
  });

  it('the same value again: no write, no audit row', async () => {
    bureauRoles({ [OWNER]: 'owner' }, true);
    expect(await setBureauSharingSetting({ bureauId: BUREAU, actorUserId: OWNER, value: true }))
      .toEqual({ kind: 'ok', changed: false, oldValue: true, newValue: true });
    expect(txMock).toHaveBeenCalledTimes(1);
  });

  it.each(['accountant', 'viewer'] as const)('a bureau %s is refused and writes nothing', async (role) => {
    bureauRoles({ someone: role }, false);
    expect(await setBureauSharingSetting({ bureauId: BUREAU, actorUserId: 'someone', value: true })).toEqual({ kind: 'forbidden' });
    expect(txMock).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/bureau/settings', () => {
  it('owner: 200 and changed', async () => {
    bureauRoles({ [OWNER]: 'owner' }, false);
    const r = await call('PUT', OWNER, { body: { bureauId: BUREAU, shareMerchantPatterns: true } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ data: { shareMerchantPatterns: true, changed: true } });
  });
  it.each(['accountant', 'viewer'] as const)('%s: 403', async (role) => {
    bureauRoles({ u: role }, false);
    const r = await call('PUT', 'u', { body: { bureauId: BUREAU, shareMerchantPatterns: true } });
    expect(r.statusCode).toBe(403);
    expect(txMock.mock.calls.some((c) => /INSERT INTO bureau_audit_log/.test((c[0] as TemplateStringsArray).join('?')))).toBe(false);
  });
  it('a non-boolean value is a 400', async () => {
    bureauRoles({ [OWNER]: 'owner' }, false);
    expect((await call('PUT', OWNER, { body: { bureauId: BUREAU, shareMerchantPatterns: 'yes' } })).statusCode).toBe(400);
  });
});

describe('GET /api/bureau/settings', () => {
  it('a non-member: 403', async () => {
    bureauRoles({}, false);
    expect((await call('GET', 'stranger', { query: { bureauId: BUREAU } })).statusCode).toBe(403);
  });
  it('a viewer sees the setting and cannot edit it', async () => {
    bureauRoles({ v: 'viewer' }, true);
    const r = await call('GET', 'v', { query: { bureauId: BUREAU } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ data: { shareMerchantPatterns: true, canEdit: false, role: 'viewer' } });
  });
  it('the owner can edit it', async () => {
    bureauRoles({ [OWNER]: 'owner' }, false);
    expect((await call('GET', OWNER, { query: { bureauId: BUREAU } })).body).toMatchObject({ data: { canEdit: true } });
  });
});
