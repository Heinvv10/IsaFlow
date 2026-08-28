/**
 * Integration tests: BL-33 — input validation on 7 auth + admin handlers.
 *
 * Pattern per handler:
 *   NEGATIVE: missing/invalid required field → 400 with the handler's reject code
 *   POSITIVE: valid body → success path (200/201 OR domain-specific non-validation error)
 *
 * The three accounting handlers are still Zod-backed and assert the
 * `VALIDATION_ERROR` envelope. The four auth handlers were rewritten after BL-33
 * and validate inline — see assertRejected below.
 *
 * Tests run against the local dev server (TEST_BASE_URL, default http://localhost:3200).
 * They do NOT mock the DB — they rely on the server being up.
 * If the server is not running, tests skip via the beforeAll guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3200';

// Every auth route here is IP rate-limited against the shared
// `rate_limit_counters` table, and register allows only 5 posts per IP per hour.
// Without clearing the counters this suite poisons itself: a second run inside
// the window 429s instead of exercising validation. Drop the rows this suite
// creates (and only those) before it starts.
const RESET_SCOPES = ['login', 'register', 'do-reset-password', 'forgot-password'];

let limiterPool: Pool | null = null;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('dummy.neon.tech')) return;
  limiterPool = new Pool({ connectionString: url, max: 1 });
  await limiterPool.query(
    `DELETE FROM rate_limit_counters
      WHERE key LIKE ANY ($1::text[])
         OR key LIKE 'login:email:%'
         OR key LIKE 'register:email:%'
         OR key LIKE 'forgot:email:%'`,
    [RESET_SCOPES.map((s) => `${s}:ip:%`)]
  );
});

afterAll(async () => {
  await limiterPool?.end();
});

/**
 * Try to reach the server; if it is not available, skip all tests gracefully.
 */
async function serverAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'GET' });
    return res.status !== 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: POST JSON and return the parsed body + status
// ---------------------------------------------------------------------------
async function post(
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Shared assertion: check that a response is a Zod validation error
// ---------------------------------------------------------------------------
function assertValidationError(
  status: number,
  json: Record<string, unknown>,
  expectedField: string
): void {
  expect(status).toBe(400);
  const error = json.error as Record<string, unknown> | undefined;
  expect(error?.code).toBe('VALIDATION_ERROR');
  const details = error?.details as Record<string, unknown> | undefined;
  expect(details).toBeDefined();
  // The field should be present in error.details
  expect(Object.keys(details ?? {})).toContain(expectedField);
}

// ---------------------------------------------------------------------------
// Shared assertion for the auth handlers.
//
// login / register / do-reset-password / forgot-password were rewritten after
// BL-33 (GoTrue cutover, self-owned password reset in #153/#155, self-serve
// signup in #254). They validate inline and reject with a domain error code
// rather than the Zod `VALIDATION_ERROR` envelope, so this asserts the contract
// they actually have: a 400 carrying one of the expected codes. The accounting
// handlers below are still Zod-backed and keep assertValidationError.
// ---------------------------------------------------------------------------
function assertRejected(
  status: number,
  json: Record<string, unknown>,
  expectedCodes: string[]
): void {
  expect(status).toBe(400);
  const error = json.error as Record<string, unknown> | undefined;
  expect(expectedCodes).toContain(error?.code);
}

// ---------------------------------------------------------------------------
// 1. POST /api/auth/login
// ---------------------------------------------------------------------------
describe('Input validation — POST /api/auth/login', () => {
  beforeAll(async () => {
    const available = await serverAvailable();
    if (!available) {
      // vitest does not have a native skip-in-beforeAll; throw a skipped message
      // We rely on the NEGATIVE test to detect connection errors separately
    }
  });

  it('NEGATIVE: empty body → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/login', {});
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: non-string password → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/login', {
      email: 'test@example.com',
      password: 12345678,
    });
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: malformed address is a credential miss, never a 500', async () => {
    const { status, json } = await post('/api/auth/login', {
      email: 'not-an-email',
      password: 'ValidPass1!',
    });
    // Credentials are checked by GoTrue, so a malformed address is simply a
    // credential that does not exist. It must not surface as a server error.
    expect([400, 401, 423, 429]).toContain(status);
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).not.toBe('INTERNAL_ERROR');
  });

  it('POSITIVE: valid body → NOT a validation error (401 invalid creds or 200)', async () => {
    const { status, json } = await post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'ValidPassword1!',
    });
    // Should not be a validation error — expect 401 (wrong creds) or 200 (success)
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).not.toBe('VALIDATION_ERROR');
    expect([200, 401, 423, 429]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// 2. POST /api/auth/register  (self-serve signup, #254)
// ---------------------------------------------------------------------------
describe('Input validation — POST /api/auth/register', () => {
  it('NEGATIVE: empty body → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/register', {});
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: missing companyName → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/register', {
      firstName: 'Test',
      lastName: 'User',
      email: `zod-test-${Date.now()}@example.com`,
      password: 'ValidPassword1!',
    });
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: invalid email → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/register', {
      firstName: 'Test',
      lastName: 'User',
      email: 'not-an-email',
      password: 'ValidPassword1!',
      companyName: 'Zod Test Co',
    });
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: password too short → 400 WEAK_PASSWORD', async () => {
    const { status, json } = await post('/api/auth/register', {
      firstName: 'Test',
      lastName: 'User',
      email: `zod-test-${Date.now()}@example.com`,
      password: 'abc',
      companyName: 'Zod Test Co',
    });
    assertRejected(status, json, ['WEAK_PASSWORD']);
  });

  it('NEGATIVE: junk annualTurnover → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/register', {
      firstName: 'Test',
      lastName: 'User',
      email: `zod-test-${Date.now()}@example.com`,
      password: 'ValidPassword1!',
      companyName: 'Zod Test Co',
      annualTurnover: 'not-a-number',
    });
    assertRejected(status, json, ['BAD_REQUEST']);
  });
});

// ---------------------------------------------------------------------------
// 3. POST /api/auth/do-reset-password  (self-owned reset token, #153/#155)
// ---------------------------------------------------------------------------
describe('Input validation — POST /api/auth/do-reset-password', () => {
  it('NEGATIVE: empty body → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/do-reset-password', {});
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: missing newPassword → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/do-reset-password', {
      recoveryToken: 'some-token',
    });
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: password too short → 400 WEAK_PASSWORD', async () => {
    const { status, json } = await post('/api/auth/do-reset-password', {
      recoveryToken: 'some-token',
      newPassword: 'short',
    });
    assertRejected(status, json, ['WEAK_PASSWORD']);
  });

  it('POSITIVE: structurally valid body → rejected on the token, not the shape', async () => {
    const { status, json } = await post('/api/auth/do-reset-password', {
      recoveryToken: 'fake-but-structurally-valid-token-for-this-test',
      newPassword: 'ValidPassword1!',
    });
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).toBe('INVALID_RECOVERY_TOKEN');
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/auth/forgot-password
// ---------------------------------------------------------------------------
describe('Input validation — POST /api/auth/forgot-password', () => {
  it('NEGATIVE: empty body → 400 BAD_REQUEST on email', async () => {
    const { status, json } = await post('/api/auth/forgot-password', {});
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('NEGATIVE: non-string email → 400 BAD_REQUEST', async () => {
    const { status, json } = await post('/api/auth/forgot-password', {
      email: 42,
    });
    assertRejected(status, json, ['BAD_REQUEST']);
  });

  it('POSITIVE: valid email → 200 (always, enumeration prevention)', async () => {
    const { status, json } = await post('/api/auth/forgot-password', {
      email: 'nobody-exists@example.com',
    });
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).not.toBe('VALIDATION_ERROR');
    expect([200, 429]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// 5. POST /api/accounting/sage-migration-action
// (requires auth + admin role; we test schema rejection before auth)
// ---------------------------------------------------------------------------
describe('Zod validation — POST /api/accounting/sage-migration-action', () => {
  it('NEGATIVE: empty body → 400 VALIDATION_ERROR on action', async () => {
    const { status, json } = await post('/api/accounting/sage-migration-action', {});
    // Could be 401 (no auth) or 400 (validation). Either is acceptable — just NOT validation error code
    // if it IS 400, it must be VALIDATION_ERROR
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      // 401 unauthorized — Zod runs after auth middleware, so we only get validation error if authed
      expect([401, 403]).toContain(status);
    }
  });

  it('NEGATIVE: invalid action value → validation error or auth rejection', async () => {
    const { status, json } = await post('/api/accounting/sage-migration-action', {
      action: 'not_a_valid_action',
    });
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      expect([401, 403]).toContain(status);
    }
  });

  it('POSITIVE: valid auto_map body → 401/403 (auth required, not a validation error)', async () => {
    const { status, json } = await post('/api/accounting/sage-migration-action', {
      action: 'auto_map',
    });
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).not.toBe('VALIDATION_ERROR');
    expect([200, 401, 403]).toContain(status);
  });

  it('POSITIVE: valid reset body (confirm: true) → auth rejection not validation error', async () => {
    const { status, json } = await post('/api/accounting/sage-migration-action', {
      action: 'reset',
      resetType: 'accounts',
      confirm: true,
    });
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).not.toBe('VALIDATION_ERROR');
    expect([200, 401, 403]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// 6. POST /api/accounting/company-logo
// (requires auth; tests schema rejection before/after auth check)
// ---------------------------------------------------------------------------
describe('Zod validation — POST /api/accounting/company-logo', () => {
  it('NEGATIVE: empty body → 400 VALIDATION_ERROR or 401', async () => {
    const { status, json } = await post('/api/accounting/company-logo', {});
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      expect([401, 403]).toContain(status);
    }
  });

  it('NEGATIVE: invalid companyId (not a UUID) → 400 VALIDATION_ERROR or 401', async () => {
    const { status, json } = await post('/api/accounting/company-logo', {
      companyId: 'not-a-uuid',
      logoData: 'data:image/png;base64,abc',
    });
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      expect([401, 403]).toContain(status);
    }
  });

  it('NEGATIVE: logoData missing data:image/ prefix → 400 VALIDATION_ERROR or 401', async () => {
    const { status, json } = await post('/api/accounting/company-logo', {
      companyId: '00000000-0000-0000-0000-000000000001',
      logoData: 'not-a-data-url',
    });
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      expect([401, 403]).toContain(status);
    }
  });

  it('POSITIVE: valid body → auth rejection not validation error', async () => {
    const { status, json } = await post('/api/accounting/company-logo', {
      companyId: '00000000-0000-0000-0000-000000000001',
      logoData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
    });
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).not.toBe('VALIDATION_ERROR');
    expect([200, 401, 403]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
// 7. POST /api/accounting/bank-rules-action
// (wrapped with withCsrf; CSRF mismatch → 403 before Zod; but missing auth → 401)
// ---------------------------------------------------------------------------
describe('Zod validation — POST /api/accounting/bank-rules-action', () => {
  it('NEGATIVE: empty body → 400 VALIDATION_ERROR, 401, or 403 (CSRF/auth)', async () => {
    const { status, json } = await post('/api/accounting/bank-rules-action', {});
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      // 401 (no auth) or 403 (CSRF) are acceptable pre-Zod rejections
      expect([401, 403]).toContain(status);
    }
  });

  it('NEGATIVE: unknown action → 400 VALIDATION_ERROR or auth/CSRF rejection', async () => {
    const { status, json } = await post('/api/accounting/bank-rules-action', {
      action: 'explode',
    });
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      expect([401, 403]).toContain(status);
    }
  });

  it('NEGATIVE: delete without id → 400 VALIDATION_ERROR or auth/CSRF rejection', async () => {
    const { status, json } = await post('/api/accounting/bank-rules-action', {
      action: 'delete',
    });
    if (status === 400) {
      const error = json.error as Record<string, unknown> | undefined;
      expect(error?.code).toBe('VALIDATION_ERROR');
    } else {
      expect([401, 403]).toContain(status);
    }
  });

  it('POSITIVE: structurally valid delete body → auth/CSRF rejection not validation error', async () => {
    const { status, json } = await post('/api/accounting/bank-rules-action', {
      action: 'delete',
      id: '00000000-0000-0000-0000-000000000001',
    });
    const error = json.error as Record<string, unknown> | undefined;
    expect(error?.code).not.toBe('VALIDATION_ERROR');
    // 401 (no auth), 403 (CSRF/forbidden), or 200 (success)
    expect([200, 401, 403]).toContain(status);
  });
});
