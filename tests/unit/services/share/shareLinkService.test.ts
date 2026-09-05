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
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  clampTtlDays,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  ShareLinkLimitError,
  MAX_LIVE_LINKS,
} from '@/modules/accounting/services/share/shareLinkService';
import { hashShareToken } from '@/modules/accounting/services/share/shareToken';
import type { SharePackParams } from '@/modules/accounting/services/share/shareParams';

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

beforeEach(() => sqlMock.mockReset());

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
    sqlMock.mockResolvedValue([dbRow()]);
    const { token } = await createShareLink({
      companyId: COMPANY, userId: 'user-1', params: PARAMS,
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const params = values();
    expect(params).toContain(hashShareToken(token));
    expect(params).not.toContain(token);
    expect(JSON.stringify(params)).not.toContain(token);
  });

  it('scopes the insert to the caller company and passes the clamped ttl', async () => {
    sqlMock.mockResolvedValue([dbRow()]);
    await createShareLink({
      companyId: COMPANY, userId: 'user-1', params: PARAMS, ttlDays: 4000,
    });

    expect(values()[0]).toBe(COMPANY);
    expect(values()).toContain(90);
    expect(text()).toContain('INSERT INTO share_links');
    expect(text()).toContain('company_id');
  });

  it('serialises params as JSON so a caller cannot smuggle extra keys into a column', async () => {
    sqlMock.mockResolvedValue([dbRow()]);
    await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(values()).toContain(JSON.stringify(PARAMS));
  });

  it('never returns the token hash to the caller', async () => {
    sqlMock.mockResolvedValue([dbRow()]);
    const { link } = await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(JSON.stringify(link)).not.toContain('not-the-token');
    expect(link.id).toBe(LINK_ID);
    expect(link.reportKind).toBe('pack');
    expect(link.expiresAt).toBe('2026-04-01T00:00:00.000Z');
    expect(link.revokedAt).toBeNull();
    expect(link.viewCount).toBe(0);
  });

  it('refuses to mint past the live-link cap, and says so distinguishably', async () => {
    // The guarded INSERT ... SELECT returns no row when the company is already
    // at the cap, which is the only signal the service gets.
    sqlMock.mockResolvedValue([]);
    await expect(
      createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS }),
    ).rejects.toBeInstanceOf(ShareLinkLimitError);

    expect(text()).toContain('revoked_at IS NULL');
    expect(text()).toContain('expires_at > NOW()');
    expect(values()).toContain(MAX_LIVE_LINKS);
  });

  it('counts only this company towards the cap', async () => {
    sqlMock.mockResolvedValue([dbRow()]);
    await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(values()).not.toContain(OTHER_COMPANY);
    // The guard subquery and the inserted row are scoped to the same company.
    expect(values().filter(v => v === COMPANY).length).toBeGreaterThanOrEqual(2);
  });

  it('carries a null label through rather than the string "null"', async () => {
    sqlMock.mockResolvedValue([dbRow()]);
    const { link } = await createShareLink({ companyId: COMPANY, userId: 'user-1', params: PARAMS });
    expect(link.label).toBeNull();
    expect(values()).toContain(null);
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
    sqlMock.mockResolvedValue([]);
    const ok = await revokeShareLink(COMPANY, LINK_ID, 'user-1');

    expect(ok).toBe(false);
    expect(values()).toContain(COMPANY);
    expect(values()).toContain(LINK_ID);
    expect(values()).not.toContain(OTHER_COMPANY);
    expect(text()).toContain('company_id');
    expect(text()).toContain('revoked_at IS NULL');
  });

  it('returns true only when a row was actually updated', async () => {
    sqlMock.mockResolvedValue([{ id: LINK_ID }]);
    expect(await revokeShareLink(COMPANY, LINK_ID, 'user-1')).toBe(true);
  });
});
