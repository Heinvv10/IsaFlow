/**
 * OAuth code + PKCE + refresh coverage — PRD-10 Layer 2 (MCP Phase 0, Task 0.2).
 *
 * Security invariants under test:
 *  - auth-code exchange is a single atomic UPDATE: PKCE S256 check, single-use
 *    (used_at) and expiry guards live in the SAME statement that consumes the code
 *  - a wrong verifier / reused / expired code → invalid_grant, never tokens
 *  - refresh rotation is atomic; a rotated-out ort_ presented again REVOKES the
 *    whole authorisation (stolen-token replay defence)
 *  - scopes on minted oat_ come from the stored consent row, never caller input
 *  - only sha256 hashes touch the DB — raw oac_/oat_/ort_ never appear in SQL values
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

import { log } from '@/lib/logger';
import {
  exchangeCode,
  refreshAccessToken,
  OauthExchangeError,
} from '@/lib/auth/oauth';
import {
  sqlMock,
  resetSqlMock,
  mockSqlOnce,
  sqlCallText,
  sqlCallValues,
  allSqlValues,
} from './helpers';

const APP_ID = '44444444-4444-4444-4444-444444444444';
const AUTH_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = 'user-gotrue-1';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';

const CODE = `oac_${'C'.repeat(32)}`;
const VERIFIER = 'verifier-string-with-plenty-of-entropy-0123456789';
const REDIRECT = 'https://client.example/callback';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

beforeEach(() => {
  resetSqlMock();
  vi.mocked(log.warn).mockClear();
});

describe('exchangeCode (auth-code grant)', () => {
  const codeRow = {
    user_id: USER_ID,
    company_id: COMPANY_ID,
    scopes: ['read:reports', 'offline_access'],
  };

  it('happy path: consumes the code and mints hashed oat_/ort_ tokens', async () => {
    mockSqlOnce([codeRow]); // atomic consume UPDATE returns the consent row
    const result = await exchangeCode({
      code: CODE,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      oauthAppId: APP_ID,
    });

    expect(result.accessToken).toMatch(/^oat_[A-Za-z0-9]{32}$/);
    expect(result.refreshToken).toMatch(/^ort_[A-Za-z0-9]{32}$/);
    expect(result.accessTokenExpiresIn).toBe(3600);
    expect(result.scopes).toEqual(['read:reports', 'offline_access']);

    // The consume query is keyed on the code HASH and the S256(verifier) challenge.
    const consumeValues = sqlCallValues(0);
    expect(consumeValues).toContain(sha256Hex(CODE));
    expect(consumeValues).toContain(s256Challenge(VERIFIER));

    // Only hashes are persisted — raw tokens never appear in any SQL value.
    const persisted = allSqlValues();
    expect(persisted).toContain(sha256Hex(result.accessToken));
    expect(persisted).toContain(sha256Hex(result.refreshToken));
    for (const raw of [CODE, result.accessToken, result.refreshToken]) {
      expect(persisted).not.toContain(raw);
    }
  });

  it('PKCE, single-use, and expiry guards live in ONE atomic consume statement', async () => {
    mockSqlOnce([codeRow]);
    await exchangeCode({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, oauthAppId: APP_ID });
    const text = sqlCallText(0);
    expect(text).toContain('SET used_at = NOW()');
    expect(text).toContain('used_at IS NULL');
    expect(text).toContain('expires_at > NOW()');
    expect(text).toContain('code_challenge =');
    expect(text).toContain('redirect_uri =');
  });

  it('rejects a PKCE S256 verifier mismatch without minting tokens', async () => {
    // wrong verifier → challenge differs → WHERE matches 0 rows
    mockSqlOnce([]);
    await expect(
      exchangeCode({ code: CODE, redirectUri: REDIRECT, codeVerifier: 'wrong-verifier', oauthAppId: APP_ID }),
    ).rejects.toThrowError(
      expect.objectContaining({ name: 'OauthExchangeError', code: 'invalid_grant' }),
    );
    expect(sqlCallValues(0)).toContain(s256Challenge('wrong-verifier'));
    // no token insert happened — the consume UPDATE was the only statement
    expect(sqlMock.mock.calls.length).toBe(1);
  });

  it('auth code is single-use: second exchange of the same code is rejected', async () => {
    mockSqlOnce([codeRow]); // first consume wins
    const first = await exchangeCode({
      code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, oauthAppId: APP_ID,
    });
    expect(first.accessToken).toMatch(/^oat_/);

    // second consume: used_at is now set → guard filters the row → 0 rows
    await expect(
      exchangeCode({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, oauthAppId: APP_ID }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'invalid_grant' }));
  });

  it('scopes on the minted oat_ come from the stored consent row, never caller input', async () => {
    mockSqlOnce([{ ...codeRow, scopes: ['read:invoices'] }]);
    const result = await exchangeCode({
      code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, oauthAppId: APP_ID,
    });
    expect(result.scopes).toEqual(['read:invoices']);
    // consented scopes flow into the authorisation insert unchanged
    expect(sqlCallValues(1)).toEqual(expect.arrayContaining([['read:invoices']]));
    // no offline_access consented → no refresh token minted
    expect(result.refreshToken).toBe('');
  });
});

describe('refreshAccessToken (rotation + replay defence)', () => {
  const OLD_REFRESH = `ort_${'R'.repeat(32)}`;
  const CLIENT_ID = 'client_abc123';
  const rotatedRow = {
    id: AUTH_ID,
    user_id: USER_ID,
    company_id: COMPANY_ID,
    scopes: ['read:reports', 'offline_access'],
  };

  it('rotates atomically: new oat_/ort_ issued, old hash stashed as previous', async () => {
    mockSqlOnce([{ id: APP_ID }]); // client lookup
    mockSqlOnce([rotatedRow]);     // rotation UPDATE wins
    const result = await refreshAccessToken({ refreshToken: OLD_REFRESH, clientId: CLIENT_ID });

    expect(result.accessToken).toMatch(/^oat_[A-Za-z0-9]{32}$/);
    expect(result.refreshToken).toMatch(/^ort_[A-Za-z0-9]{32}$/);
    expect(result.refreshToken).not.toBe(OLD_REFRESH);
    expect(result.scopes).toEqual(['read:reports', 'offline_access']);

    const rotationText = sqlCallText(1);
    // single-statement rotation: old hash keyed in WHERE, stashed for replay detection
    expect(rotationText).toContain('previous_refresh_token_hash = refresh_token_hash');
    expect(rotationText).toContain('revoked_at IS NULL');
    expect(rotationText).toContain('refresh_token_expires_at > NOW()');
    const rotationValues = sqlCallValues(1);
    expect(rotationValues).toContain(sha256Hex(OLD_REFRESH));
    expect(rotationValues).toContain(sha256Hex(result.refreshToken));
    expect(allSqlValues()).not.toContain(OLD_REFRESH);
    expect(allSqlValues()).not.toContain(result.refreshToken);
  });

  it('replaying a rotated-out ort_ REVOKES the entire authorisation', async () => {
    mockSqlOnce([{ id: APP_ID }]); // client lookup
    mockSqlOnce([]);               // rotation finds no current-hash row
    mockSqlOnce([{ id: AUTH_ID, user_id: USER_ID, company_id: COMPANY_ID }]); // previous-hash match

    await expect(
      refreshAccessToken({ refreshToken: OLD_REFRESH, clientId: CLIENT_ID }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'invalid_grant' }));

    const replayText = sqlCallText(2);
    expect(replayText).toContain('SET revoked_at = NOW()');
    expect(replayText).toContain('previous_refresh_token_hash =');
    expect(sqlCallValues(2)).toContain(sha256Hex(OLD_REFRESH));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('replay'),
      expect.objectContaining({ clientId: CLIENT_ID }),
      'oauth',
    );
  });

  it('rejects refresh of a revoked (or unknown/expired) authorisation', async () => {
    mockSqlOnce([{ id: APP_ID }]); // client lookup
    mockSqlOnce([]);               // rotation: revoked_at IS NULL guard fails
    mockSqlOnce([]);               // replay probe: nothing to revoke either
    await expect(
      refreshAccessToken({ refreshToken: OLD_REFRESH, clientId: CLIENT_ID }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'invalid_grant' }));
    expect(sqlCallText(1)).toContain('revoked_at IS NULL');
  });

  it('rejects an unknown client before touching any token row', async () => {
    mockSqlOnce([]); // client lookup misses
    await expect(
      refreshAccessToken({ refreshToken: OLD_REFRESH, clientId: 'client_ghost' }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'invalid_client' }));
    expect(sqlMock.mock.calls.length).toBe(1);
  });

  it('OauthExchangeError carries a machine code and no token material', () => {
    const err = new OauthExchangeError('invalid_grant', 'generic message');
    expect(err.name).toBe('OauthExchangeError');
    expect(err.code).toBe('invalid_grant');
    expect(err.message).not.toMatch(/oat_|ort_|oac_/);
  });
});
