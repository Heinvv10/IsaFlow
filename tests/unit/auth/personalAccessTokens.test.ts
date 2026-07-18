/**
 * PAT lifecycle tests — PRD-10 Layer 3 (MCP Connector Phase 0, Task 0.1).
 *
 * Security invariants under test:
 *  - only sha256(token) is ever persisted or queried — never the plaintext
 *  - verify honours expiry and revocation (guards live in the lookup SQL)
 *  - a tampered token hashes to a different value and never matches
 *  - the scope vocabulary is closed (PAT_SCOPES) — unknown scopes throw
 *  - expiry is hard-capped at 365 days and floored at 1
 *  - every read/write is scoped by user_id AND company_id (multi-tenant)
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

import {
  PAT_SCOPES,
  generatePat,
  validatePat,
  createPat,
  revokePat,
  listPats,
} from '@/lib/auth/personalAccessTokens';
import {
  sqlMock,
  resetSqlMock,
  mockSqlOnce,
  sqlCallText,
  sqlCallValues,
  allSqlValues,
} from './helpers';

const USER_ID = 'user-gotrue-1';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const PAT_ID = '33333333-3333-3333-3333-333333333333';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  resetSqlMock();
});

describe('PAT_SCOPES vocabulary', () => {
  it('includes the MCP read scopes (contacts, vat)', () => {
    expect(PAT_SCOPES).toContain('read:contacts');
    expect(PAT_SCOPES).toContain('read:vat');
  });
});

describe('generatePat', () => {
  it('produces unique pat_-prefixed tokens with matching hash and display prefix', () => {
    const a = generatePat();
    const b = generatePat();
    expect(a.raw).toMatch(/^pat_[A-Za-z0-9]{32}$/);
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).toBe(sha256(a.raw));
    expect(a.prefix).toBe(a.raw.slice(0, 12));
  });
});

describe('createPat (mint)', () => {
  const input = {
    userId: USER_ID,
    companyId: COMPANY_ID,
    name: 'Month-end automation',
    scopes: ['read:reports'],
    expiresInDays: 90,
  };

  it('mints pat_ prefixed token and stores only the SHA-256 hash, never the raw token', async () => {
    mockSqlOnce([{ id: PAT_ID }]);
    const { id, raw, prefix } = await createPat(input);
    expect(id).toBe(PAT_ID);
    expect(raw).toMatch(/^pat_[A-Za-z0-9]{32}$/);
    expect(prefix).toBe(raw.slice(0, 12));
    const persisted = allSqlValues();
    expect(persisted).toContain(sha256(raw));
    expect(persisted).not.toContain(raw);
  });

  it('scopes the insert to the minting user and company (multi-tenant)', async () => {
    mockSqlOnce([{ id: PAT_ID }]);
    await createPat(input);
    expect(sqlCallValues(0)).toEqual(expect.arrayContaining([USER_ID, COMPANY_ID]));
  });

  it('rejects minting with a scope outside PAT_SCOPES', async () => {
    await expect(
      createPat({ ...input, scopes: ['admin:everything'] }),
    ).rejects.toThrow(/unknown scope/);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('accepts every scope in the PAT_SCOPES vocabulary', async () => {
    mockSqlOnce([{ id: PAT_ID }]);
    await expect(
      createPat({ ...input, scopes: [...PAT_SCOPES] }),
    ).resolves.toMatchObject({ id: PAT_ID });
  });

  it('caps expiry at 365 days', async () => {
    mockSqlOnce([{ id: PAT_ID }]);
    await createPat({ ...input, expiresInDays: 10_000 });
    expect(sqlCallValues(0)).toContain(365);
    expect(sqlCallValues(0)).not.toContain(10_000);
  });

  it('floors expiry at 1 day', async () => {
    mockSqlOnce([{ id: PAT_ID }]);
    await createPat({ ...input, expiresInDays: 0 });
    expect(sqlCallValues(0)).toContain(1);
  });

  it('throws when the insert returns no row instead of minting silently', async () => {
    mockSqlOnce([]);
    await expect(createPat(input)).rejects.toThrow(/no row/);
  });
});

describe('validatePat (verify)', () => {
  const raw = `pat_${'A'.repeat(32)}`;
  const validRow = {
    id: PAT_ID,
    user_id: USER_ID,
    company_id: COMPANY_ID,
    scopes: ['read:reports', 'read:invoices'],
  };

  it('verify returns user+company+scopes for a valid unexpired token', async () => {
    mockSqlOnce([validRow]);
    const ctx = await validatePat(raw, '10.0.0.1');
    expect(ctx).toEqual({
      patId: PAT_ID,
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['read:reports', 'read:invoices'],
    });
    // The lookup uses the hash — the plaintext never touches the DB.
    expect(sqlCallValues(0)).toContain(sha256(raw));
    expect(allSqlValues()).not.toContain(raw);
  });

  it('verify rejects an expired token', async () => {
    // expires_at > NOW() lives in the lookup SQL, so an expired row comes back empty
    mockSqlOnce([]);
    await expect(validatePat(raw, null)).resolves.toBeNull();
    expect(sqlCallText(0)).toContain('expires_at > NOW()');
  });

  it('verify rejects a revoked token', async () => {
    mockSqlOnce([]);
    await expect(validatePat(raw, null)).resolves.toBeNull();
    expect(sqlCallText(0)).toContain('revoked_at IS NULL');
  });

  it('verify rejects a tampered token (one flipped char → hash mismatch)', async () => {
    const tampered = `${raw.slice(0, -1)}B`; // raw ends in 'A'
    expect(tampered).not.toBe(raw);
    expect(sha256(tampered)).not.toBe(sha256(raw));
    mockSqlOnce([]); // tampered hash matches no stored row
    await expect(validatePat(tampered, null)).resolves.toBeNull();
    expect(sqlCallValues(0)).toContain(sha256(tampered));
    expect(sqlCallValues(0)).not.toContain(sha256(raw));
  });

  it('short-circuits tokens without the pat_ prefix before any DB query', async () => {
    await expect(validatePat(`oat_${'A'.repeat(32)}`, null)).resolves.toBeNull();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('records last-used metadata fire-and-forget without blocking the result', async () => {
    mockSqlOnce([validRow]);
    const ctx = await validatePat(raw, '10.0.0.1');
    expect(ctx).not.toBeNull();
    // second sql call is the last_used_at/last_used_ip update
    expect(sqlMock.mock.calls.length).toBe(2);
    expect(sqlCallText(1)).toContain('last_used_at');
    expect(sqlCallValues(1)).toEqual(expect.arrayContaining(['10.0.0.1', PAT_ID]));
  });
});

describe('revokePat', () => {
  it('revokes only the caller-owned token within the caller company', async () => {
    mockSqlOnce([{ id: PAT_ID }]);
    await expect(revokePat(PAT_ID, USER_ID, COMPANY_ID)).resolves.toBe(true);
    expect(sqlCallText(0)).toContain('revoked_at = NOW()');
    expect(sqlCallValues(0)).toEqual(
      expect.arrayContaining([PAT_ID, USER_ID, COMPANY_ID]),
    );
  });

  it('returns false when the token is unknown, already revoked, or not owned', async () => {
    mockSqlOnce([]);
    await expect(revokePat(PAT_ID, USER_ID, COMPANY_ID)).resolves.toBe(false);
  });
});

describe('listPats', () => {
  it('scopes the listing by user AND company and never exposes the hash', async () => {
    const ts = new Date('2026-07-18T10:00:00Z');
    mockSqlOnce([
      {
        id: PAT_ID,
        name: 'CI token',
        token_prefix: 'pat_AAAAAAAA',
        scopes: ['read:reports'],
        expires_at: ts,
        last_used_at: null,
        created_at: ts,
      },
    ]);
    const items = await listPats(USER_ID, COMPANY_ID);
    expect(items).toEqual([
      {
        id: PAT_ID,
        name: 'CI token',
        prefix: 'pat_AAAAAAAA',
        scopes: ['read:reports'],
        expiresAt: ts.toISOString(),
        lastUsedAt: null,
        createdAt: ts.toISOString(),
      },
    ]);
    expect(sqlCallValues(0)).toEqual(expect.arrayContaining([USER_ID, COMPANY_ID]));
    expect(sqlCallText(0)).not.toContain('token_hash');
  });
});
