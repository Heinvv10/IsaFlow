/**
 * registerOauthApp dynamic-mode extension — MCP Phase 1, Task 1.3.
 *
 * Invariants:
 *  - dynamic:true mints NO secret (null columns, null return), is_dynamic=true,
 *    token_endpoint_auth_method 'none', ownerless
 *  - non-dynamic path unchanged: cls_ secret hashed-at-rest, owner required
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

import { registerOauthApp } from '@/lib/auth/oauth';
import { pruneStaleDynamicApps } from '@/lib/auth/oauthDynamicClients';
import { sqlMock, resetSqlMock, mockSqlOnce, sqlCallText, sqlCallValues, allSqlValues } from './helpers';

const APP_ID = '44444444-4444-4444-4444-444444444444';

beforeEach(() => {
  resetSqlMock();
});

describe('registerOauthApp — dynamic public clients', () => {
  it('mints no secret: null secret columns, clientSecret null, auth method none', async () => {
    mockSqlOnce([{ id: APP_ID }]);
    const app = await registerOauthApp({
      ownerUserId: null,
      name: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      dynamic: true,
    });

    expect(app.id).toBe(APP_ID);
    expect(app.clientId).toMatch(/^client_[A-Za-z0-9]{24}$/);
    expect(app.clientSecret).toBeNull();

    const values = sqlCallValues(0);
    expect(values).toContain(true);       // is_dynamic
    expect(values).toContain('none');     // token_endpoint_auth_method
    expect(values.filter((v) => v === null).length).toBeGreaterThanOrEqual(2); // secret hash + prefix
    expect(allSqlValues().some((v) => typeof v === 'string' && v.startsWith('cls_'))).toBe(false);
  });

  it('non-dynamic path unchanged: cls_ secret hashed at rest, owner required', async () => {
    mockSqlOnce([{ id: APP_ID }]);
    const app = await registerOauthApp({
      ownerUserId: 'user-1',
      name: 'My Integration',
      redirectUris: ['https://example.com/cb'],
    });

    expect(app.clientSecret).toMatch(/^cls_[A-Za-z0-9]{32}$/);
    const values = sqlCallValues(0);
    const hash = createHash('sha256').update(app.clientSecret!).digest('hex');
    expect(values).toContain(hash);
    expect(values).not.toContain(app.clientSecret);
    expect(values).toContain(false);                 // is_dynamic
    expect(values).toContain('client_secret_post');  // auth method
  });

  it('rejects a non-dynamic registration without an owner', async () => {
    await expect(
      registerOauthApp({ ownerUserId: null, name: 'x', redirectUris: ['https://e.com/cb'] }),
    ).rejects.toThrow(/ownerUserId required/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('still rejects empty or malformed redirect URIs', async () => {
    await expect(
      registerOauthApp({ ownerUserId: null, name: 'x', redirectUris: [], dynamic: true }),
    ).rejects.toThrow(/redirect URI/);
    await expect(
      registerOauthApp({ ownerUserId: null, name: 'x', redirectUris: ['not a url'], dynamic: true }),
    ).rejects.toThrow(/invalid redirect URI/);
  });
});

describe('pruneStaleDynamicApps', () => {
  it('deletes ONLY stale, never-authorised dynamic rows (guards in one statement)', async () => {
    mockSqlOnce([{ id: 'a' }, { id: 'b' }]);
    await expect(pruneStaleDynamicApps()).resolves.toBe(2);
    const text = sqlCallText(0);
    expect(text).toContain('DELETE FROM oauth_apps');
    expect(text).toContain('is_dynamic');
    expect(text).toContain('created_at <');
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('oauth_authorisations');
    expect(sqlCallValues(0)).toContain(30); // 30-day staleness window
  });

  it('returns 0 quietly when nothing is stale', async () => {
    mockSqlOnce([]);
    await expect(pruneStaleDynamicApps()).resolves.toBe(0);
  });
});
