/**
 * Email-verification token service.
 *
 * The security properties under test:
 *   - the raw token is never persisted (only sha256), so a table read can't be
 *     replayed to activate someone's account
 *   - consumption is atomic and single-use, so a double-clicked link can't
 *     provision two tenants
 *   - minting invalidates prior live tokens for the same user
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import crypto from 'crypto';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { sqlMock, withTransactionMock, txMock } = vi.hoisted(() => {
  const txMock = vi.fn();
  return {
    sqlMock: vi.fn(),
    txMock,
    withTransactionMock: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: withTransactionMock }));

import {
  createEmailVerificationToken,
  consumeEmailVerificationToken,
  findConsumedVerification,
  invalidateVerificationTokensForUser,
  purgeExpiredVerificationTokens,
  type PendingSignup,
} from '@/lib/auth/emailVerificationService';
import type { QueryRunner } from '@/modules/onboarding/services/tenantProvisioningService';

const mockSql = sqlMock as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;
const mockTx = txMock as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown>>;

const userId = '11111111-1111-1111-1111-111111111111';
const pending: PendingSignup = {
  email: 'lead@example.co.za',
  firstName: 'Lead',
  lastName: 'Person',
  companyName: 'Lead Co',
  phone: null,
  annualTurnoverCents: 75_000_000,
  signupType: 'direct',
};

/** Flatten a tagged-template call into an inspectable statement + values. */
function callsOf(mock: MockedFunction<(...a: unknown[]) => Promise<unknown>>) {
  return mock.mock.calls.map((call) => ({
    text: Array.isArray(call[0]) ? (call[0] as string[]).join(' ? ') : String(call[0]),
    values: call.slice(1),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.mockResolvedValue([]);
  mockSql.mockResolvedValue([]);
});

describe('createEmailVerificationToken', () => {
  it('returns a 256-bit raw token and a future expiry', async () => {
    const { token, expiresAt } = await createEmailVerificationToken(userId, pending);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('persists only the sha256 hash — never the raw token', async () => {
    const { token } = await createEmailVerificationToken(userId, pending);
    const expectedHash = crypto.createHash('sha256').update(token).digest('hex');

    const insert = callsOf(mockTx).find((c) => /INSERT INTO auth_email_verification_tokens/i.test(c.text));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain(expectedHash);
    expect(insert!.values).not.toContain(token);
  });

  it('invalidates prior live tokens for the same user in the same transaction', async () => {
    await createEmailVerificationToken(userId, pending);
    const statements = callsOf(mockTx).map((c) => c.text).join('\n---\n');
    expect(statements).toMatch(/UPDATE auth_email_verification_tokens[\s\S]*consumed_at = now\(\)/i);
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('parks the pending signup as JSON without any credential field', async () => {
    await createEmailVerificationToken(userId, pending);
    const insert = callsOf(mockTx).find((c) => /INSERT INTO auth_email_verification_tokens/i.test(c.text))!;
    const payload = insert.values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.companyName).toBe('Lead Co');
    expect(parsed.annualTurnoverCents).toBe(75_000_000);
    expect(parsed).not.toHaveProperty('password');
  });
});

/** Records statements so the test can assert on SQL shape, not just outcome. */
function fakeClient(rows: unknown[]): { client: QueryRunner; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client: QueryRunner = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows } as never;
    },
  };
  return { client, calls };
}

describe('consumeEmailVerificationToken', () => {
  it('returns the parked signup when the token is live', async () => {
    const { client } = fakeClient([{ gotrue_user_id: userId, payload: pending }]);
    const result = await consumeEmailVerificationToken(client, 'a'.repeat(64));
    expect(result).toEqual({ gotrueUserId: userId, pending });
  });

  it('runs on the CALLER\'s client so it shares their transaction', async () => {
    // If this ran on the module-level `sql` connection instead, a provisioning
    // failure could not roll the consumption back and the link would be burnt.
    const { client, calls } = fakeClient([{ gotrue_user_id: userId, payload: pending }]);
    await consumeEmailVerificationToken(client, 'a'.repeat(64));
    expect(calls).toHaveLength(1);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('looks the token up by hash, never by raw value', async () => {
    const raw = 'b'.repeat(64);
    const { client, calls } = fakeClient([{ gotrue_user_id: userId, payload: pending }]);
    await consumeEmailVerificationToken(client, raw);

    expect(calls[0]!.values).toContain(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(calls[0]!.values).not.toContain(raw);
  });

  it('consumes atomically — the UPDATE itself excludes used and expired rows', async () => {
    const { client, calls } = fakeClient([{ gotrue_user_id: userId, payload: pending }]);
    await consumeEmailVerificationToken(client, 'c'.repeat(64));

    const { text } = calls[0]!;
    // Single statement: SET consumed_at guarded by consumed_at IS NULL, RETURNING
    // the row. A read-then-write would let two concurrent clicks both win.
    expect(text).toMatch(/UPDATE auth_email_verification_tokens/i);
    expect(text).toMatch(/SET consumed_at = now\(\)/i);
    expect(text).toMatch(/consumed_at IS NULL/i);
    expect(text).toMatch(/expires_at > now\(\)/i);
    expect(text).toMatch(/RETURNING/i);
  });

  it('returns null when the token is unknown, already used, or expired', async () => {
    const { client } = fakeClient([]);
    expect(await consumeEmailVerificationToken(client, 'd'.repeat(64))).toBeNull();
  });
});

describe('findConsumedVerification', () => {
  it('finds a consumed token so a half-finished signup can be completed', async () => {
    mockSql.mockResolvedValueOnce([{ gotrue_user_id: userId, payload: pending }]);
    expect(await findConsumedVerification('e'.repeat(64))).toEqual({
      gotrueUserId: userId,
      pending,
    });
  });

  it('only matches CONSUMED rows — a live token must go through consume', async () => {
    mockSql.mockResolvedValueOnce([]);
    await findConsumedVerification('f'.repeat(64));
    expect(callsOf(mockSql)[0]!.text).toMatch(/consumed_at IS NOT NULL/i);
  });

  it('does not mutate the row', async () => {
    mockSql.mockResolvedValueOnce([]);
    await findConsumedVerification('0'.repeat(64));
    const { text } = callsOf(mockSql)[0]!;
    expect(text).toMatch(/^\s*SELECT/i);
    expect(text).not.toMatch(/UPDATE|DELETE/i);
  });
});

describe('purgeExpiredVerificationTokens', () => {
  it('deletes only unconsumed expired rows and reports the count', async () => {
    mockSql.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]);
    expect(await purgeExpiredVerificationTokens()).toBe(2);

    const { text } = callsOf(mockSql)[0]!;
    expect(text).toMatch(/DELETE FROM auth_email_verification_tokens/i);
    expect(text).toMatch(/consumed_at IS NULL/i);
    expect(text).toMatch(/expires_at < now\(\)/i);
  });

  it('touches token rows only — never users or companies', async () => {
    // It once also nominated GoTrue users for deletion, which raced with a
    // signup verifying in the same moment and destroyed a real customer's login.
    mockSql.mockResolvedValueOnce([]);
    await purgeExpiredVerificationTokens();

    const { text } = callsOf(mockSql)[0]!;
    expect(text).not.toMatch(/company_users|companies|users/i);
  });
});

describe('invalidateVerificationTokensForUser', () => {
  it('consumes every live token for that user', async () => {
    mockSql.mockResolvedValueOnce([{ id: '1' }]);
    expect(await invalidateVerificationTokensForUser(userId)).toBe(1);

    const { text, values } = callsOf(mockSql)[0]!;
    expect(text).toMatch(/UPDATE auth_email_verification_tokens/i);
    expect(text).toMatch(/consumed_at IS NULL/i);
    expect(values).toContain(userId);
  });

  it('is scoped to one user', async () => {
    mockSql.mockResolvedValueOnce([]);
    await invalidateVerificationTokensForUser(userId);
    expect(callsOf(mockSql)[0]!.text).toMatch(/WHERE gotrue_user_id =/i);
  });
});
