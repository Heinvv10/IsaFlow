/**
 * The authenticated side of share links.
 *
 * The properties pinned here are the ones a mistake would make invisible: the
 * raw token must never reach a column, the TTL must not exceed 90 days however
 * it is asked for, and every read and every write must carry company_id. A
 * revoke that forgot its company_id filter would still return `true` on the
 * happy path and pass any test that only checked the happy path — so the
 * cross-company cases are asserted on the SQL parameters, not on the result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const adminMock = vi.fn();
// S-07d (migration 935): create and revoke run on the migration_admin pool.
// migrationAdminTx hands the callback a client whose query(text, params) feeds
// adminMock, so the assertions see the statements in the order the service
// issued them: SET LOCAL lock_timeout, the advisory lock, then the insert.
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: (_label: string, fn: (c: unknown) => unknown) =>
    fn({ query: async (t: string, p?: unknown[]) => ({ rows: await adminMock(t, p) }) }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  ShareLinkLimitError,
  MAX_LIVE_LINKS,
} from '@/modules/accounting/services/share/shareLinkService';
import { hashShareToken } from '@/modules/accounting/services/share/shareToken';
// Imported from the module that DEFINES it. shareLinkService re-exported it
// for this test alone, which is not a reason for a public export to exist.
import { clampTtlDays } from '@/modules/accounting/services/share/shareTtl';
import type { SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const PARAMS: SharePackParams = { type: 'board', from: '2026-01-01', to: '2026-03-31' };

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  company_id: COMPANY,
  report_kind: 'pack',
  params: PARAMS,
  token_hash: 'not-the-token',
  label: null,
  expires_at: new Date('2026-04-01T00:00:00Z'),
  revoked_at: null,
  revoked_by: null,
  created_by: 'user-1',
  created_at: new Date('2026-01-02T09:00:00Z'),
  view_count: 0,
  last_viewed_at: null,
  ...over,
});

/** The interpolated values of the Nth `sql` call. */
const values = (call = 0): unknown[] => sqlMock.mock.calls[call]!.slice(1);
const text = (call = 0): string => (sqlMock.mock.calls[call]![0] as string[]).join(' ? ');
/** The Nth `client.query` on the migration_admin client: text and bound params. */
const aText = (call: number): string => adminMock.mock.calls[call]![0] as string;
const aValues = (call: number): unknown[] => (adminMock.mock.calls[call]![1] ?? []) as unknown[];
// create: 0 = SET LOCAL lock_timeout, 1 = advisory lock, 2 = guarded insert.
const LOCK = 1;
const INSERT = 2;

beforeEach(() => { sqlMock.mockReset(); adminMock.mockReset(); });

describe('clampTtlDays', () => {
  it('defaults to 30 when unset', () => {
    expect(clampTtlDays(undefined)).toBe(30);
  });

  it('caps at 90 days however large the ask', () => {
    expect(clampTtlDays(91)).toBe(90);
    expect(clampTtlDays(3650)).toBe(90);
    expect(clampTtlDays(Number.MAX_SAFE_INTEGER)).toBe(90);
  });

  it('refuses zero, negative and non-finite days rather than minting a dead or eternal link', () => {
    expect(clampTtlDays(0)).toBe(30);
    expect(clampTtlDays(-1)).toBe(30);
    expect(clampTtlDays(-9999)).toBe(30);
    expect(clampTtlDays(Number.NaN)).toBe(30);
    expect(clampTtlDays(Number.POSITIVE_INFINITY)).toBe(30);
  });

  it('truncates a fractional day', () => {
    expect(clampTtlDays(7.9)).toBe(7);
  });
});

describe('createShareLink', () => {
  it('stores the sha256 of the token and never the token itself', async () => {
    adminMock.mockResolvedValue([dbRow()]);
    const { token } = await createShareLink({
      companyId: COMPANY, userId: 'user-1', params: PARAMS,
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const params = aValues(INSERT);
    expect(params).toContain(hashShareToken(token));
    expect(params).not.toContain(token);
    expect(JSON.stringify(params)).not.toContain(token);
  });

  it('scopes the insert to the caller company and passes the clamped ttl', async () => {
    adminMock.mockResolvedValue([dbRow()]);
    await createShareLink({
      companyId: COMPANY, userId: 'user-1', params: PARAMS, ttlDays: 4000,
    });

    expect(aValues(INSERT)[0]).toBe(COMPANY);
    expect(aValues(INSERT)).toContain(90);
    expect(aText(INSERT)).toContain('INSERT INTO share_links');
    expect(aText(INSERT)).toContain('company_id');
  });

  it('serialises params as JSON so a caller cannot smuggle extra keys into a column', async () => {
    adminMock.mockResolvedValue([dbRow()]);
    await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(aValues(INSERT)).toContain(JSON.stringify(PARAMS));
  });

  it('never returns the token hash to the caller', async () => {
    adminMock.mockResolvedValue([dbRow()]);
    const { link } = await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(JSON.stringify(link)).not.toContain('not-the-token');
    expect(link.id).toBe(LINK_ID);
    expect(link.reportKind).toBe('pack');
    expect(link.expiresAt).toBe('2026-04-01T00:00:00.000Z');
    expect(link.revokedAt).toBeNull();
    expect(link.viewCount).toBe(0);
  });

  it('takes a company-scoped advisory lock BEFORE the counted insert', async () => {
    // Proven necessary against a live database: under READ COMMITTED two
    // concurrent guarded inserts at 99 live rows both succeed, landing 101.
    // The count subquery reads a snapshot that cannot see the other session's
    // uncommitted row, so the single statement does not serialise anything.
    adminMock.mockResolvedValue([dbRow()]);
    await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });

    expect(adminMock).toHaveBeenCalledTimes(3);
    expect(aText(0)).toContain('lock_timeout');
    expect(aText(LOCK)).toContain('pg_advisory_xact_lock');
    expect(aValues(LOCK)).toEqual([`share:link-create:${COMPANY}`]);
    expect(aText(INSERT)).toContain('INSERT INTO share_links');
  });

  it('scopes the lock to the company, so two companies do not block each other', async () => {
    adminMock.mockResolvedValue([dbRow()]);
    await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    const first = aValues(LOCK)[0];
    adminMock.mockClear();
    await createShareLink({ companyId: OTHER_COMPANY, userId: 'user-1', params: PARAMS });
    expect(aValues(LOCK)[0]).not.toBe(first);
  });

  it('refuses to mint past the live-link cap, and says so distinguishably', async () => {
    // The guarded INSERT ... SELECT returns no row when the company is already
    // at the cap, which is the only signal the service gets.
    adminMock.mockResolvedValue([]);
    await expect(
      createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS }),
    ).rejects.toBeInstanceOf(ShareLinkLimitError);

    expect(aText(INSERT)).toContain('revoked_at IS NULL');
    expect(aText(INSERT)).toContain('expires_at > NOW()');
    expect(aValues(INSERT)).toContain(MAX_LIVE_LINKS);
  });

  it('counts only this company towards the cap', async () => {
    adminMock.mockResolvedValue([dbRow()]);
    await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(aValues(INSERT)).not.toContain(OTHER_COMPANY);
    // The guard subquery and the inserted row are scoped to the same company:
    // one bound param ($1), referenced by both the SELECT list and the count's WHERE.
    expect(aValues(INSERT).filter(v => v === COMPANY)).toHaveLength(1);
    expect(aText(INSERT)).toMatch(/SELECT\s+\$1::uuid/);
    expect(aText(INSERT)).toMatch(/WHERE company_id = \$1::uuid/);
  });

  it('carries a null label through rather than the string "null"', async () => {
    adminMock.mockResolvedValue([dbRow()]);
    const { link } = await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(link.label).toBeNull();
    expect(aValues(INSERT)).toContain(null);
  });
});

describe('listShareLinks', () => {
  it('lists only live links, so a revoked or expired one cannot fill the page', async () => {
    sqlMock.mockResolvedValue([]);
    await listShareLinks(COMPANY);
    expect(text()).toContain('revoked_at IS NULL');
    expect(text()).toContain('expires_at > NOW()');
    expect(text()).toContain('created_at DESC');
  });

  it('filters by company and does not select the token hash', async () => {
    sqlMock.mockResolvedValue([dbRow(), dbRow({ id: 'b', revoked_at: new Date('2026-02-01T00:00:00Z') })]);
    const rows = await listShareLinks(COMPANY);

    expect(values()).toEqual([COMPANY]);
    expect(text()).toContain('company_id');
    expect(text()).not.toContain('token_hash');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.revokedAt).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('revokeShareLink', () => {
  it('binds both the id and the caller company so a foreign id matches nothing', async () => {
    adminMock.mockResolvedValue([]);
    const ok = await revokeShareLink(COMPANY, LINK_ID, 'user-1');

    expect(ok).toBe(false);
    expect(aValues(0)).toContain(COMPANY);
    expect(aValues(0)).toContain(LINK_ID);
    expect(aValues(0)).not.toContain(OTHER_COMPANY);
    expect(aText(0)).toContain('company_id');
    expect(aText(0)).toContain('revoked_at IS NULL');
  });

  it('returns true only when a row was actually updated', async () => {
    adminMock.mockResolvedValue([{ id: LINK_ID }]);
    expect(await revokeShareLink(COMPANY, LINK_ID, 'user-1')).toBe(true);
  });
});
