/**
 * Bureau merchant-pattern sharing: owner-only toggle, one audit row per real change, and the route's auth.
 * The owner is bureaus.owner_user_id (bureauService.getBureauRole), re-checked inside the write transaction;
 * here the queries are answered as Postgres would answer them, and the real SQL runs against a schema in
 * tests/integration/bureau-audit-log-rls.int.test.ts (including a stale bureau_users 'owner' row) and, on the
 * production logins, bureau-consent-links.int.test.ts. The setting is read and written on the migration_admin
 * pool (migration 932); its client's query(text, params) is answered through txMock with each $N as '?'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { sqlMock, txMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), txMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (_label: string, fn: (c: unknown) => unknown) => fn({
    query: async (text: string, params: unknown[] = []) =>
      ({ rows: await txMock(Object.assign(text.split(/\$\d+/), { raw: [] }) as unknown as TemplateStringsArray, ...params) }),
  }),
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

type Role = 'owner' | 'accountant' | 'viewer';

/**
 * The queries answered as Postgres would: `owner` is bureaus.owner_user_id, `members` the bureau_users rows.
 * `roles` is the shorthand where the one 'owner' member is also owner_user_id.
 */
function bureauOf(ownerUserId: string | null, members: Record<string, Role>, current: boolean) {
  txMock.mockImplementation(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?');
    if (/owner_user_id = \?\s+FOR UPDATE/.test(text)) {
      return vals[1] === ownerUserId ? [{ share_merchant_patterns: current }] : [];
    }
    if (/SELECT share_merchant_patterns FROM bureaus/.test(text)) return [{ share_merchant_patterns: current }];
    return [];
  });
  sqlMock.mockImplementation(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?');
    if (/LEFT JOIN bureau_users bu/.test(text)) {
      const user = vals[0] as string;
      const role = user === ownerUserId ? 'owner' : members[user] === 'owner' ? 'accountant' : members[user];
      return role ? [{ role }] : [];
    }
    if (/SELECT share_merchant_patterns FROM bureaus/.test(text)) return [{ share_merchant_patterns: current }];
    return [];
  });
}
function bureauRoles(roles: Record<string, Role>, current: boolean) {
  bureauOf(Object.keys(roles).find((u) => roles[u] === 'owner') ?? null, roles, current);
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

beforeEach(() => { sqlMock.mockReset(); txMock.mockReset(); process.env.MERCHANT_SHARING_ENABLED = 'true'; });
afterEach(() => { delete process.env.MERCHANT_SHARING_ENABLED; });

describe('setBureauSharingSetting', () => {
  it('owner switching it on: updates the bureau and writes one audit row, old -> new', async () => {
    bureauRoles({ [OWNER]: 'owner' }, false);
    expect(await setBureauSharingSetting({ bureauId: BUREAU, actorUserId: OWNER, value: true }))
      .toEqual({ kind: 'ok', changed: true, oldValue: false, newValue: true });
    expect(txText(0)).toMatch(/b\.owner_user_id = \?/);
    expect(txText(0)).toMatch(/FOR UPDATE/);
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

describe('who the owner is: bureaus.owner_user_id', () => {
  it('a stale bureau_users "owner" row that is not owner_user_id reads as accountant and cannot toggle', async () => {
    bureauOf('the-owner', { 'old-owner': 'owner' }, false);
    expect((await call('GET', 'old-owner', { query: { bureauId: BUREAU } })).body)
      .toMatchObject({ data: { role: 'accountant', canEdit: false } });
    expect((await call('PUT', 'old-owner', { body: { bureauId: BUREAU, shareMerchantPatterns: true } })).statusCode).toBe(403);
  });
  it('owner_user_id with no bureau_users row is still the owner: not locked out', async () => {
    bureauOf('the-owner', {}, false);
    expect((await call('GET', 'the-owner', { query: { bureauId: BUREAU } })).body)
      .toMatchObject({ data: { role: 'owner', canEdit: true } });
    expect((await call('PUT', 'the-owner', { body: { bureauId: BUREAU, shareMerchantPatterns: true } })).statusCode).toBe(200);
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

describe('the legal-review gate (MERCHANT_SHARING_ENABLED)', () => {
  const putAs = (user: string, value: boolean) => call('PUT', user, { body: { bureauId: BUREAU, shareMerchantPatterns: value } });
  const wrote = () => txMock.mock.calls.some((c) => /UPDATE bureaus|INSERT INTO bureau_audit_log/.test((c[0] as TemplateStringsArray).join('?')));

  it.each([undefined, 'false', '1'])('off (%s): the owner switching it on is a 409 sharing_pending_legal_review, nothing written', async (v) => {
    if (v === undefined) delete process.env.MERCHANT_SHARING_ENABLED; else process.env.MERCHANT_SHARING_ENABLED = v;
    bureauRoles({ [OWNER]: 'owner' }, false);
    const r = await putAs(OWNER, true);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ error: { details: { code: 'sharing_pending_legal_review' } } });
    expect(wrote()).toBe(false);
  });
  it('off: switching it off still works for the owner', async () => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    bureauRoles({ [OWNER]: 'owner' }, true);
    const r = await putAs(OWNER, false);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ data: { shareMerchantPatterns: false, changed: true } });
  });
  it.each(['accountant', 'viewer'] as const)('off: a %s switching it on is a 403, not the gate', async (role) => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    bureauRoles({ [OWNER]: 'owner', u: role }, false);
    expect((await putAs('u', true)).statusCode).toBe(403);
    expect(wrote()).toBe(false);
  });
  it('off: a non-member naming any bureau is a 403', async () => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    bureauRoles({ [OWNER]: 'owner' }, false);
    expect((await putAs('stranger', true)).statusCode).toBe(403);
  });
  it('off: on again for a bureau already on is a no-op, not a 409', async () => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    bureauRoles({ [OWNER]: 'owner' }, true);
    const r = await putAs(OWNER, true);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ data: { shareMerchantPatterns: true, changed: false } });
    expect(wrote()).toBe(false);
  });
  it('off: GET reports sharingAvailable false', async () => {
    delete process.env.MERCHANT_SHARING_ENABLED;
    bureauRoles({ [OWNER]: 'owner' }, false);
    expect((await call('GET', OWNER, { query: { bureauId: BUREAU } })).body).toMatchObject({ data: { sharingAvailable: false, canEdit: true } });
  });
  it('on: the owner_user_id owner may switch it on; a bureau_users "owner" who is not owner_user_id may not', async () => {
    bureauOf('the-owner', { 'the-owner': 'owner', 'other-owner-row': 'owner' }, false);
    expect((await putAs('other-owner-row', true)).statusCode).toBe(403);
    expect(wrote()).toBe(false);
    expect((await putAs('the-owner', true)).statusCode).toBe(200);
    expect((await call('GET', 'the-owner', { query: { bureauId: BUREAU } })).body).toMatchObject({ data: { sharingAvailable: true } });
  });
});
