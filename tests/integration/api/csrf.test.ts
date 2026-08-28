/**
 * Integration test: CSRF double-submit enforcement on a money-moving endpoint (BL-22).
 *
 * This used to read a pre-minted admin token out of a machine-local
 * /tmp/isaflow-admin-token.env, so it errored on every machine that had never
 * run whatever produced that file. It now mints its own session the way the
 * other integration tests do — seed a throwaway company + user + membership,
 * sign a GoTrue-shaped JWT with JWT_SECRET — and drives the real endpoint over
 * HTTP so the whole middleware chain (withAuth → withCsrf → withWriteAccess)
 * is exercised rather than mocked.
 *
 * The endpoint is pages/api/accounting/bank-transactions-action, wrapped as
 * withAuth(withErrorHandler(withCsrf(withWriteAccess(handler)))). Auth is
 * outermost, so a session is required before the CSRF gate is even reached —
 * which is exactly why this needs a real one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3200';
const PROTECTED_ENDPOINT = '/api/accounting/bank-transactions-action';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const HAS_ENV = Boolean(JWT_SECRET && DATABASE_URL && !DATABASE_URL.includes('dummy.neon.tech'));

// Fixed ids so a crashed run leaves exactly one recognisable row to clean up
// rather than accumulating fresh ones.
const COMPANY_ID = '00000000-0000-0000-0000-00000000c5f1';
const USER_ID = 'csrf-bl22-test-user';
const CSRF_TOKEN = 'x'.repeat(48);

let pool: Pool | null = null;
let sessionCookie = '';

async function seed(): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1, 'BL-22 CSRF Test Co', true)
       ON CONFLICT (id) DO NOTHING`,
    [COMPANY_ID],
  );
  await pool.query(
    `INSERT INTO users (id, email, role, is_active) VALUES ($1, 'csrf-bl22@test.local', 'admin', true)
       ON CONFLICT (id) DO UPDATE SET role = 'admin', is_active = true`,
    [USER_ID],
  );
  await pool.query(
    `INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT DO NOTHING`,
    [COMPANY_ID, USER_ID],
  );
}

beforeAll(async () => {
  if (!HAS_ENV) return;
  assertNotProductionDb('This test inserts a throwaway company, user and membership.');
  pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  await seed();
  const token = await new SignJWT({ sub: USER_ID, aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET as string));
  sessionCookie = `sb-access-token=${token}; active_company_id=${COMPANY_ID}`;
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM company_users WHERE company_id = $1`, [COMPANY_ID]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [COMPANY_ID]);
  await pool.end();
});

async function serverAvailable(): Promise<boolean> {
  try {
    await fetch(`${BASE}${PROTECTED_ENDPOINT}`, { method: 'GET' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!HAS_ENV)('CSRF on money-moving endpoints (BL-22)', () => {
  beforeAll(async () => {
    if (!(await serverAvailable())) {
      throw new Error(
        `Dev server not reachable at ${BASE}. Start it (bun run dev) or set TEST_BASE_URL.`,
      );
    }
  });

  it('authenticates the seeded session — the CSRF assertions below are not just 401s', async () => {
    // Guards the whole file: if the session stopped working, every "not 403"
    // assertion would pass vacuously on a 401.
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'GET',
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(400); // NO_ACTIVE_COMPANY
  });

  it('GET does NOT require CSRF', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'GET',
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).not.toBe(403);
  });

  it('POST without CSRF cookie + header → 403', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'exclude', id: '00000000-0000-0000-0000-000000000001' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST with a header that does not match the cookie → 403', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; isaflow_csrf=${CSRF_TOKEN}`,
        'x-csrf-token': 'y'.repeat(48),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'exclude', id: '00000000-0000-0000-0000-000000000001' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST with a matching double-submit pair passes the CSRF gate', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; isaflow_csrf=${CSRF_TOKEN}`,
        'x-csrf-token': CSRF_TOKEN,
        'Content-Type': 'application/json',
      },
      // Deliberately references a transaction that does not exist: the point is
      // that the request reaches the handler and is judged on its contents, not
      // rejected as a forgery. It must never actually mutate anything.
      body: JSON.stringify({ action: 'exclude', id: '00000000-0000-0000-0000-000000000001' }),
    });
    expect(res.status).not.toBe(403);
  });
});
