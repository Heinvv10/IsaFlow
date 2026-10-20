/**
 * Reviewer sandbox seed (scripts/sandbox/reviewer-sandbox.ts) against a real,
 * throwaway Postgres. GoTrue is replaced by an in-memory stand-in (CI has no
 * live GoTrue); everything else — the company, users, membership, override and
 * the fictional books written through the app's services — is real.
 *
 *  - --apply twice is idempotent (row counts unchanged, password not rotated)
 *  - hasFeature(sandbox, 'mcp_connector') is true
 *  - under app_user the reviewer sees no other company's rows
 *  - --teardown leaves no reviewer membership and no override
 *
 * Never point this at a real database: assertNotProductionDb refuses one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { asAppUser } from './r035-pr4.helpers';

const gotrue = vi.hoisted(() => ({ users: new Map<string, { id: string; email: string }>() }));
vi.mock('@/lib/auth/gotrue', () => ({
  adminGetUserByEmail: vi.fn(async (email: string) => {
    const u = gotrue.users.get(email.toLowerCase());
    if (!u) throw new Error(`no gotrue user with email ${email}`);
    return u;
  }),
  adminCreateUser: vi.fn(async ({ email }: { email: string }) => {
    const u = { id: randomUUID(), email };
    gotrue.users.set(email.toLowerCase(), u);
    return u;
  }),
  adminUpdateUser: vi.fn(async (id: string) => ({ id, email: '' })),
  adminDeleteUser: vi.fn(async (id: string) => {
    for (const [k, u] of gotrue.users) if (u.id === id) gotrue.users.delete(k);
  }),
}));

import { CONFIRM_VALUE, runSandbox, type SandboxDeps } from '../../scripts/sandbox/reviewer-sandbox';
import { SANDBOX_COMPANY } from '../../scripts/sandbox/reviewerSandboxData';
import { writeCredentialsFile } from '../../scripts/sandbox/reviewerSandboxGuards';
import { createSql, closeSql } from '../../scripts/_pg';
import { hasFeature } from '@/modules/admin/services/featureFlagService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
// The localhost fixture speaks no SSL; scripts/_pg turns it off only on sslmode=disable.
const SEED_URL = DATABASE_URL && !DATABASE_URL.includes('sslmode=')
  ? `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}sslmode=disable`
  : DATABASE_URL;

const SANDBOX = SANDBOX_COMPANY.id;
const OPERATOR = 'reviewer-sandbox-it-operator';
const EMAIL = 'reviewer-sandbox-it@example.com';

let pool: pg.Pool;
let credsPath: string;

function deps(lines: string[]): SandboxDeps {
  return {
    env: {
      REVIEWER_SANDBOX_CONFIRM: CONFIRM_VALUE, SANDBOX_OPERATOR_USER_ID: OPERATOR, REVIEWER_SANDBOX_EMAIL: EMAIL,
      REVIEWER_SANDBOX_CREDENTIALS_PATH: credsPath,
      DATABASE_URL: SEED_URL, GOTRUE_URL: 'http://gotrue.invalid', SUPABASE_SERVICE_ROLE_KEY: 'not-used-gotrue-is-mocked',
    },
    today: new Date(),
    repoRoot: process.cwd(),
    out: (l) => lines.push(l),
    load: async () => {
      const identity = await import('../../scripts/sandbox/reviewerSandboxIdentity');
      const books = await import('../../scripts/sandbox/reviewerSandboxBooks');
      return { sql: createSql(SEED_URL), identity, seedBooks: books.seedBooks };
    },
    newPassword: () => `it-${randomUUID()}`,
    writeCredentials: writeCredentialsFile,
  };
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['customers', 'suppliers', 'customer_invoices', 'customer_payments', 'supplier_invoices',
    'gl_journal_entries', 'bank_transactions', 'company_users', 'company_feature_overrides']) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [SANDBOX]);
    out[table] = r.rows[0].n as number;
  }
  return out;
}

describeIfDb('reviewer sandbox seed (scripts/sandbox/reviewer-sandbox.ts)', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates the reviewer sandbox company and its fictional books.');
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    pool.on('error', (err) => { process.stderr.write(`reviewer-sandbox it pool error: ${err.message}\n`); });
    credsPath = join(mkdtempSync(join(tmpdir(), 'reviewer-sandbox-it-')), 'creds.json');
    await pool.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active, role)
       VALUES ($1, 'reviewer-sandbox-it-operator@example.com', 'Demo', 'Operator', true, 'super_admin')
       ON CONFLICT (id) DO UPDATE SET role = 'super_admin', is_active = true`, [OPERATOR]);
  }, 120000);

  afterAll(async () => {
    await closeSql();
    await pool?.end();
  });

  it('--apply twice is idempotent and enables the connector; --teardown removes the reviewer', async () => {
    const first: string[] = [];
    await runSandbox(['--apply'], deps(first));
    expect(existsSync(credsPath)).toBe(true);
    const after1 = await counts();
    expect(after1).toMatchObject({ customers: 5, suppliers: 3, customer_invoices: 8, supplier_invoices: 4, company_users: 1 });
    expect(after1.bank_transactions).toBe(15);
    expect(await hasFeature(SANDBOX, 'mcp_connector')).toBe(true);

    const second: string[] = [];
    await runSandbox(['--apply'], deps(second));
    expect(await counts()).toEqual(after1);
    expect(second.join('\n')).toContain('password left unchanged');

    // Under app_user, the reviewer reads the sandbox and nothing else.
    const reviewerId = gotrue.users.get(EMAIL)!.id;
    const seen = await asAppUser(pool, reviewerId, SANDBOX, async (client) => {
      const own = await client.query('SELECT count(*)::int AS n FROM customers WHERE company_id = $1', [SANDBOX]);
      const other = await client.query('SELECT count(*)::int AS n FROM customers WHERE company_id <> $1', [SANDBOX]);
      return { own: own.rows[0].n as number, other: other.rows[0].n as number };
    });
    expect(seen).toEqual({ own: 5, other: 0 });

    await runSandbox(['--teardown'], deps([]));
    const after = await counts();
    expect(after.company_users).toBe(0);
    expect(after.company_feature_overrides).toBe(0);
    expect(gotrue.users.has(EMAIL)).toBe(false);
    expect(await hasFeature(SANDBOX, 'mcp_connector')).toBe(false);
  }, 300000);
});
