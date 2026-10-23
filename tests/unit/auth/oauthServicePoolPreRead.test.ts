/**
 * S-07c: the token endpoint's service-pool pre-reads (oauth.test.ts harness).
 *
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

// S-07c (migration 930): oauth writes run on the migration_admin pool; the
// client lookup (a SELECT) stays on sql.
const { adminQueryMock } = vi.hoisted(() => ({ adminQueryMock: vi.fn() }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminPool: () => ({ query: adminQueryMock }),
  migrationAdminTx: (_label: string, fn: (c: unknown) => unknown) => fn({ query: adminQueryMock }),
}));
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
} from '@/lib/auth/oauth';
import { resetSqlMock, mockSqlOnce, sqlCallText } from './helpers';

const APP_ID = '44444444-4444-4444-4444-444444444444';

const CODE = `oac_${'C'.repeat(32)}`;
const VERIFIER = 'verifier-string-with-plenty-of-entropy-0123456789';
const REDIRECT = 'https://client.example/callback';

beforeEach(() => {
  resetSqlMock();
  adminQueryMock.mockReset();
  adminQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.mocked(log.warn).mockClear();
});

describe('S-07c: the token endpoint reaches migration_admin only for a token that exists', () => {
  const OLD_REFRESH = `ort_${'R'.repeat(32)}`;
  const CLIENT_ID = 'client_abc123';

  it('an unknown, used or expired code is refused on the service pool; the migration_admin pool is never used', async () => {
    mockSqlOnce([]);
    await expect(exchangeCode({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, oauthAppId: APP_ID }))
      .rejects.toThrowError(expect.objectContaining({ code: 'invalid_grant' }));
    expect(adminQueryMock).not.toHaveBeenCalled();
  });

  it('a hash no grant of the app holds is refused on the service pool; the migration_admin pool is never used', async () => {
    mockSqlOnce([{ id: APP_ID }]); // client lookup
    mockSqlOnce([]);               // no grant holds it, current or rotated out
    await expect(refreshAccessToken({ refreshToken: OLD_REFRESH, clientId: CLIENT_ID }))
      .rejects.toThrowError(expect.objectContaining({ code: 'invalid_grant' }));
    expect(adminQueryMock).not.toHaveBeenCalled();
  });

  it('a revoked or expired grant\'s current hash does not pass the pre-read; a rotated-out one does (replay revoke)', async () => {
    mockSqlOnce([{ id: APP_ID }]);
    mockSqlOnce([]);
    await refreshAccessToken({ refreshToken: OLD_REFRESH, clientId: CLIENT_ID }).catch(() => undefined);
    const text = sqlCallText(1);
    expect(text).toMatch(/refresh_token_hash = +\? +AND revoked_at IS NULL AND refresh_token_expires_at > NOW\(\)/);
    expect(text).toMatch(/OR previous_refresh_token_hash = /);
  });
});
