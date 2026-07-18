/**
 * validateOauthAccessToken + verifyClientSecret coverage (MCP Phase 0, Task 0.5
 * review fixes — blind-review HIGH: the live oat_ auth check had zero coverage).
 *
 * Security invariants under test:
 *  - oat_ lookup is hash-keyed with revocation + expiry guards in the SQL
 *  - non-oat_ tokens short-circuit before any DB query
 *  - miss (expired/revoked/unknown) → null, never a partial context
 *  - client-secret verification is hash-compared and fails closed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { validateOauthAccessToken, verifyClientSecret } from '@/lib/auth/oauth';
import {
  sqlMock,
  resetSqlMock,
  mockSqlOnce,
  sqlCallText,
  sqlCallValues,
  allSqlValues,
} from './helpers';

const AUTH_ID = '55555555-5555-5555-5555-555555555555';
const APP_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = 'user-gotrue-1';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  resetSqlMock();
});

describe('validateOauthAccessToken', () => {
  const RAW = `oat_${'T'.repeat(32)}`;
  const row = {
    id: AUTH_ID,
    oauth_app_id: APP_ID,
    user_id: USER_ID,
    company_id: COMPANY_ID,
    scopes: ['read:reports'],
    access_token_expires_at: new Date('2027-01-01T00:00:00Z'),
  };

  it('valid oat_ → returns the full authorisation context, looked up by hash only', async () => {
    mockSqlOnce([row]);
    const ctx = await validateOauthAccessToken(RAW, '10.0.0.1');
    expect(ctx).toEqual({
      authorisationId: AUTH_ID,
      oauthAppId: APP_ID,
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['read:reports'],
    });
    expect(sqlCallValues(0)).toContain(sha256Hex(RAW));
    expect(allSqlValues()).not.toContain(RAW);
  });

  it('revocation and expiry guards live in the lookup SQL itself', async () => {
    mockSqlOnce([row]);
    await validateOauthAccessToken(RAW, null);
    const text = sqlCallText(0);
    expect(text).toContain('revoked_at IS NULL');
    expect(text).toContain('access_token_expires_at > NOW()');
    expect(text).toContain('access_token_hash =');
  });

  it('expired, revoked, or unknown token → null (guards filter the row)', async () => {
    mockSqlOnce([]);
    await expect(validateOauthAccessToken(RAW, null)).resolves.toBeNull();
  });

  it('non-oat_ tokens short-circuit before any DB query', async () => {
    await expect(validateOauthAccessToken(`pat_${'T'.repeat(32)}`, null)).resolves.toBeNull();
    await expect(validateOauthAccessToken(`ort_${'T'.repeat(32)}`, null)).resolves.toBeNull();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('records last-used metadata in a separate statement keyed by authorisation id', async () => {
    mockSqlOnce([row]);
    await validateOauthAccessToken(RAW, '10.0.0.1');
    // allow the fire-and-forget microtask to run
    await new Promise((r) => setImmediate(r));
    expect(sqlMock.mock.calls.length).toBe(2);
    expect(sqlCallText(1)).toContain('last_used_at');
    expect(sqlCallValues(1)).toEqual(expect.arrayContaining(['10.0.0.1', AUTH_ID]));
  });
});

describe('verifyClientSecret', () => {
  const CLIENT_ID = 'client_abc123';
  const SECRET = `cls_${'S'.repeat(32)}`;

  it('returns true only for the matching secret', async () => {
    mockSqlOnce([{ client_secret_hash: sha256Hex(SECRET) }]);
    await expect(verifyClientSecret(CLIENT_ID, SECRET)).resolves.toBe(true);
  });

  it('returns false for a wrong secret of the same shape', async () => {
    mockSqlOnce([{ client_secret_hash: sha256Hex(SECRET) }]);
    await expect(verifyClientSecret(CLIENT_ID, `cls_${'X'.repeat(32)}`)).resolves.toBe(false);
  });

  it('returns false for an unknown or revoked client', async () => {
    mockSqlOnce([]);
    await expect(verifyClientSecret('client_ghost', SECRET)).resolves.toBe(false);
  });

  it('fails closed for a public client with no stored secret hash', async () => {
    mockSqlOnce([{ client_secret_hash: null }]);
    await expect(verifyClientSecret(CLIENT_ID, SECRET)).resolves.toBe(false);
  });

  it('never sends the presented secret to the DB — only the client id', async () => {
    mockSqlOnce([{ client_secret_hash: sha256Hex(SECRET) }]);
    await verifyClientSecret(CLIENT_ID, SECRET);
    expect(allSqlValues()).not.toContain(SECRET);
    expect(allSqlValues()).not.toContain(sha256Hex(SECRET));
  });
});
