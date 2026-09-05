/**
 * The public side of share links — the only entry point in this feature that
 * runs with no authenticated session.
 *
 * What is pinned here is what an attacker would exercise: a token that matches
 * the shape but no row, a token whose row is expired or revoked, a token
 * presented faster than the limits allow, and a rate limiter that is itself
 * down. The company must come from the ROW in every one of those cases, and
 * every hit that matched a row must leave a share_link_views record — the
 * audit row is the only way a withdrawn link still in circulation becomes
 * visible, so the tests assert the insert, not just the returned status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const rateLimitMock = vi.fn();
const warnMock = vi.fn();
const infoMock = vi.fn();
const errorMock = vi.fn();

// withTransaction hands the callback a tagged-template `tx` bound to the same
// mock, so the ok path's INSERT and UPDATE appear in sqlMock in issue order and
// a rejection from either aborts the callback exactly as a real ROLLBACK would.
const txMock = vi.fn((fn: (tx: unknown) => unknown) => fn((...a: unknown[]) => sqlMock(...a)));
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withTransaction: (fn: (tx: unknown) => unknown) => txMock(fn),
}));
vi.mock('@/lib/logger', () => ({
  log: {
    info: (...a: unknown[]) => infoMock(...a),
    warn: (...a: unknown[]) => warnMock(...a),
    error: (...a: unknown[]) => errorMock(...a),
  },
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => rateLimitMock(...a) }));

import {
  resolveShareLink,
  recordShareView,
  redactShareToken,
} from '@/modules/accounting/services/share/shareResolver';
import { hashShareToken } from '@/modules/accounting/services/share/shareToken';
import type { SharePackParams } from '@/modules/accounting/services/share/shareParams';

const TOKEN = 'A'.repeat(43);
const TOKEN_HASH = hashShareToken(TOKEN);
const COMPANY = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const PARAMS: SharePackParams = { type: 'board', from: '2026-01-01', to: '2026-03-31' };
const CTX = { ip: '203.0.113.9', userAgent: 'curl/8' };

const linkRow = (over: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  company_id: COMPANY,
  params: PARAMS,
  expires_at: new Date(Date.now() + 86_400_000),
  revoked_at: null,
  ...over,
});

/** The interpolated values of the Nth `sql` call. */
const values = (call = 0): unknown[] => sqlMock.mock.calls[call]!.slice(1);
const text = (call = 0): string => (sqlMock.mock.calls[call]![0] as string[]).join(' ? ');

/** Index of the first `sql` call whose text contains `needle`. */
const callWith = (needle: string): number =>
  sqlMock.mock.calls.findIndex((c) => (c[0] as string[]).join(' ? ').includes(needle));

/** Every string that reached any log call, arguments included. */
const allLogText = (): string =>
  [...warnMock.mock.calls, ...infoMock.mock.calls, ...errorMock.mock.calls]
    .map((c) => JSON.stringify(c))
    .join(' ');

beforeEach(() => {
  sqlMock.mockReset();
  txMock.mockClear();
  rateLimitMock.mockReset().mockResolvedValue(true);
  warnMock.mockReset();
  infoMock.mockReset();
  errorMock.mockReset();
});

describe('resolveShareLink — token shape', () => {
  it.each([
    ['too short', 'A'.repeat(42)],
    ['too long', 'A'.repeat(44)],
    ['standard base64 padding', `${'A'.repeat(42)}=`],
    ['a path traversal', '../'.repeat(14) + 'A'],
    ['a SQL fragment', "' OR 1=1 --" + 'A'.repeat(32)],
    ['a non-string', 12345],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s without touching the database or the limiter', async (_label, bad) => {
    await expect(resolveShareLink(bad, CTX)).resolves.toEqual({ status: 'not_found' });
    expect(sqlMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});

describe('resolveShareLink — rate limiting', () => {
  it('keys the limiter on the hash and the ip, never on the raw token', async () => {
    sqlMock.mockResolvedValue([linkRow()]);
    await resolveShareLink(TOKEN, CTX);
    const keys = rateLimitMock.mock.calls.map((c) => c[0] as string);
    expect(keys).toContain(`share:ip:${CTX.ip}`);
    expect(keys).toContain(`share:token:${TOKEN_HASH}`);
    expect(keys.join(' ')).not.toContain(TOKEN);
  });

  it('does not let a missing ip collapse every visitor onto one key', async () => {
    sqlMock.mockResolvedValue([linkRow()]);
    await resolveShareLink(TOKEN, { ip: null, userAgent: null });
    const keys = rateLimitMock.mock.calls.map((c) => c[0] as string);
    expect(keys).toContain('share:ip:unknown');
  });

  it('returns rate_limited and issues no query when the per-ip bucket is full', async () => {
    rateLimitMock.mockImplementation((key: string) =>
      Promise.resolve(!key.startsWith('share:ip:')),
    );
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'rate_limited' });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('returns rate_limited when only the per-token bucket is full', async () => {
    rateLimitMock.mockImplementation((key: string) =>
      Promise.resolve(!key.startsWith('share:token:')),
    );
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'rate_limited' });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the limiter itself throws — a limiter outage must not open the door', async () => {
    rateLimitMock.mockRejectedValue(new Error('rate_limit_counters is down'));
    sqlMock.mockResolvedValue([linkRow()]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'rate_limited' });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('charges both buckets before deciding, so one full bucket cannot mask the other', async () => {
    sqlMock.mockResolvedValue([linkRow()]);
    await resolveShareLink(TOKEN, CTX);
    expect(rateLimitMock).toHaveBeenCalledTimes(2);
  });
});

describe('resolveShareLink — outcomes', () => {
  it('resolves a live link to the company on the ROW, and to its params', async () => {
    sqlMock.mockResolvedValueOnce([linkRow()]).mockResolvedValue([]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({
      status: 'ok',
      link: { id: LINK_ID, companyId: COMPANY, params: PARAMS },
    });
  });

  it('looks the row up by hash only — the raw token never reaches a query', async () => {
    sqlMock.mockResolvedValueOnce([linkRow()]).mockResolvedValue([]);
    await resolveShareLink(TOKEN, CTX);
    const flat = sqlMock.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(flat).not.toContain(TOKEN);
    expect(values(0)).toContain(TOKEN_HASH);
  });

  it('records the view and bumps the counter, both scoped by company_id', async () => {
    sqlMock.mockResolvedValueOnce([linkRow()]).mockResolvedValue([]);
    await resolveShareLink(TOKEN, CTX);

    const insert = callWith('INSERT INTO share_link_views');
    expect(insert).toBeGreaterThan(-1);
    expect(values(insert)).toEqual([COMPANY, LINK_ID, 'ok', CTX.ip, CTX.userAgent]);

    const update = callWith('UPDATE share_links');
    expect(update).toBeGreaterThan(-1);
    expect(text(update)).toContain('company_id');
    expect(values(update)).toEqual([LINK_ID, COMPANY]);
  });

  it('reports a revoked link as revoked and audits the hit', async () => {
    sqlMock.mockResolvedValueOnce([linkRow({ revoked_at: new Date('2026-02-01') })]).mockResolvedValue([]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'revoked' });
    expect(values(callWith('INSERT INTO share_link_views'))).toContain('revoked');
    expect(callWith('UPDATE share_links')).toBe(-1);
  });

  it('reports an expired link as expired and audits the hit', async () => {
    sqlMock.mockResolvedValueOnce([linkRow({ expires_at: new Date(Date.now() - 1000) })]).mockResolvedValue([]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'expired' });
    expect(values(callWith('INSERT INTO share_link_views'))).toContain('expired');
    expect(callWith('UPDATE share_links')).toBe(-1);
  });

  it('prefers revoked over expired when a link is both — withdrawal is the fact worth recording', async () => {
    sqlMock
      .mockResolvedValueOnce([linkRow({ revoked_at: new Date('2026-02-01'), expires_at: new Date(Date.now() - 1000) })])
      .mockResolvedValue([]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'revoked' });
    expect(values(callWith('INSERT INTO share_link_views'))).toContain('revoked');
  });

  it('treats a link expiring exactly now as expired', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    vi.setSystemTime(now);
    sqlMock.mockResolvedValueOnce([linkRow({ expires_at: now })]).mockResolvedValue([]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'expired' });
    vi.useRealTimers();
  });

  it('returns not_found for a well-shaped token with no row, and writes no audit row', async () => {
    sqlMock.mockResolvedValue([]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'not_found' });
    expect(callWith('INSERT INTO share_link_views')).toBe(-1);
  });

  it('refuses a row whose params are not a valid pack rather than handing them on', async () => {
    sqlMock.mockResolvedValueOnce([linkRow({ params: { type: 'payroll', from: 'x', to: 'y' } })]).mockResolvedValue([]);
    await expect(resolveShareLink(TOKEN, CTX)).resolves.toEqual({ status: 'not_found' });
    expect(callWith('UPDATE share_links')).toBe(-1);
  });

  it('propagates an audit-write failure rather than serving an unaudited view', async () => {
    sqlMock
      .mockResolvedValueOnce([linkRow()])
      .mockRejectedValueOnce(new Error('share_link_views insert failed'));
    await expect(resolveShareLink(TOKEN, CTX)).rejects.toThrow('share_link_views insert failed');
  });
});

describe('resolveShareLink — logging', () => {
  it('never logs the raw token on any path', async () => {
    for (const row of [linkRow(), linkRow({ revoked_at: new Date() }), linkRow({ expires_at: new Date(0) })]) {
      sqlMock.mockReset();
      sqlMock.mockResolvedValueOnce([row]).mockResolvedValue([]);
      await resolveShareLink(TOKEN, CTX);
    }
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
    await resolveShareLink(TOKEN, CTX);
    rateLimitMock.mockResolvedValue(false);
    await resolveShareLink(TOKEN, CTX);

    const logged = allLogText();
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(TOKEN_HASH);
  });

  it('logs the share link id and company on a revoked hit, so the withdrawal is traceable', async () => {
    sqlMock.mockResolvedValueOnce([linkRow({ revoked_at: new Date() })]).mockResolvedValue([]);
    await resolveShareLink(TOKEN, CTX);
    expect(warnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ shareLinkId: LINK_ID, companyId: COMPANY }),
      'share',
    );
  });
});

describe('recordShareView — bounded, row-scoped columns', () => {
  it('truncates an oversized user agent and ip rather than writing them whole', async () => {
    const ua = 'U'.repeat(5000);
    const ip = `${'9'.repeat(200)}`;
    sqlMock.mockResolvedValueOnce([linkRow({ revoked_at: new Date() })]).mockResolvedValue([]);
    await resolveShareLink(TOKEN, { ip, userAgent: ua });
    const v = values(callWith('INSERT INTO share_link_views'));
    expect(v[3]).toBe('9'.repeat(45));
    expect(v[4]).toBe('U'.repeat(512));
  });

  it('leaves a null ip and user agent null rather than writing an empty string', async () => {
    sqlMock.mockResolvedValueOnce([linkRow({ revoked_at: new Date() })]).mockResolvedValue([]);
    await resolveShareLink(TOKEN, { ip: null, userAgent: null });
    const v = values(callWith('INSERT INTO share_link_views'));
    expect(v[3]).toBeNull();
    expect(v[4]).toBeNull();
  });

  it('takes the id and company from one link object, so the pair cannot be mismatched', async () => {
    sqlMock.mockResolvedValue([]);
    await recordShareView({ id: LINK_ID, companyId: COMPANY }, 'ok', CTX);
    expect(values(0).slice(0, 3)).toEqual([COMPANY, LINK_ID, 'ok']);
  });
});

describe('resolveShareLink — the ok path is atomic', () => {
  it('writes the audit row and bumps the counter inside one transaction', async () => {
    sqlMock.mockResolvedValueOnce([linkRow()]).mockResolvedValue([]);
    await resolveShareLink(TOKEN, CTX);
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(callWith('INSERT INTO share_link_views')).toBeLessThan(callWith('UPDATE share_links'));
  });

  it('leaves the counter untouched when the audit insert fails', async () => {
    sqlMock
      .mockResolvedValueOnce([linkRow()])
      .mockRejectedValueOnce(new Error('share_link_views insert failed'));
    await expect(resolveShareLink(TOKEN, CTX)).rejects.toThrow('share_link_views insert failed');
    expect(callWith('UPDATE share_links')).toBe(-1);
  });

  it('opens no transaction on the revoked or expired paths', async () => {
    sqlMock.mockResolvedValueOnce([linkRow({ revoked_at: new Date() })]).mockResolvedValue([]);
    await resolveShareLink(TOKEN, CTX);
    expect(txMock).not.toHaveBeenCalled();
  });
});

describe('redactShareToken', () => {
  it('replaces the token segment of a share url', () => {
    expect(redactShareToken(`/share/${TOKEN}`)).toBe('/share/[token]');
    expect(redactShareToken(`/api/share/${TOKEN}/pdf`)).toBe('/api/share/[token]/pdf');
    expect(redactShareToken(`https://app.isaflow.co.za/share/${TOKEN}?x=1`)).toBe(
      'https://app.isaflow.co.za/share/[token]?x=1',
    );
  });

  it('redacts a token carried in a query string too', () => {
    expect(redactShareToken(`/api/share?token=${TOKEN}`)).toBe('/api/share?token=[token]');
  });

  it('redacts regardless of the case of the share segment', () => {
    expect(redactShareToken(`/SHARE/${TOKEN}`)).toBe('/SHARE/[token]');
    expect(redactShareToken(`/Share/${TOKEN}/pdf`)).toBe('/Share/[token]/pdf');
  });

  it('redacts through repeated slashes, which still route', () => {
    expect(redactShareToken(`/share//${TOKEN}`)).toBe('/share//[token]');
    expect(redactShareToken(`/share///${TOKEN}`)).toBe('/share///[token]');
  });

  it('redacts any query parameter whose name contains token', () => {
    expect(redactShareToken(`/x?share_token=${TOKEN}`)).toBe('/x?share_token=[token]');
    expect(redactShareToken(`/x?a=1&shareToken=${TOKEN}&b=2`)).toBe('/x?a=1&shareToken=[token]&b=2');
    expect(redactShareToken(`/x?TOKEN=${TOKEN}`)).toBe('/x?TOKEN=[token]');
    expect(redactShareToken(`/x?link_token_v2=${TOKEN}`)).toBe('/x?link_token_v2=[token]');
  });

  it('leaves a non-token parameter of the same length alone', () => {
    expect(redactShareToken(`/x?cursor=${TOKEN}`)).toBe(`/x?cursor=${TOKEN}`);
  });

  it('redacts every occurrence, not just the first', () => {
    const out = redactShareToken(`/share/${TOKEN} -> /share/${'B'.repeat(43)}`);
    expect(out).toBe('/share/[token] -> /share/[token]');
  });

  it('leaves urls with no token alone', () => {
    expect(redactShareToken('/api/accounting/reports/pack?type=board')).toBe(
      '/api/accounting/reports/pack?type=board',
    );
    expect(redactShareToken('/share/')).toBe('/share/');
  });

  it('does not redact a 43-character segment that is not in a share position', () => {
    expect(redactShareToken(`/api/companies/${TOKEN}`)).toBe(`/api/companies/${TOKEN}`);
  });

  it('tolerates an empty or malformed url', () => {
    expect(redactShareToken('')).toBe('');
  });
});
