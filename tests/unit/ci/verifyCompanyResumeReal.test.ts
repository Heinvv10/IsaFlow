// The resume paths through the REAL GoTrue and env-file code (realDeps: a stubbed fetch, a temp env file), not a faked signOut. The bug
// this pins: a plain re-run that resumes called the real sign-out, which needs JWT_SECRET and SUPABASE_ANON_KEY, which a plain run does not
// have; GoTrue already held the new password and the env file did not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientBase } from 'pg';
import type pg from 'pg';
import { realDeps } from '../../../scripts/deploy/verifyCompany/realDeps';
import { runProvisioning, type Deps } from '../../../scripts/deploy/verifyCompany/run';
import { APPROVER_LOGIN, LOGIN_PURPOSE, VERIFY_LOGIN } from '../../../scripts/deploy/verifyCompany/identity';

interface Call { url: string; method: string; auth: string | null }
let calls: Call[];
let dir: string;
let envFile: string;
const text = (...l: string[]) => `${l.join('\n')}\n`;

function stubGoTrue(): void {
  calls = [];
  const users = [VERIFY_LOGIN, APPROVER_LOGIN].map((w) => ({ id: `id-${w.email}`, email: w.email, app_metadata: { purpose: LOGIN_PURPOSE } }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', auth: (init.headers as Record<string, string>).Authorization ?? null });
    if (url.includes('/admin/users?filter=')) return new Response(JSON.stringify({ users }), { status: 200 });
    if (url.includes('/admin/users/') && init.method === 'PUT') return new Response(JSON.stringify({ id: 'x', email: 'x' }), { status: 200 });
    if (url.includes('/logout')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  }));
}

/** realDeps for GoTrue and the env file; everything that needs a database or the app is a fake that succeeds. */
function deps(): Deps {
  const db = { query: async () => ({ rows: [] }) } as unknown as pg.Client;
  const real = realDeps(db, envFile, 'http://app.test', () => undefined, [join(dir, 'a.lock'), join(dir, 'b.lock')]);
  return {
    ...real,
    lock: { acquire: async () => true, unlock: async () => undefined },
    deployLocks: { acquire: async () => ({ unlock: async () => undefined }) },
    ensureDb: async () => ({ companyId: 'co', userCreated: false, approverCreated: false, companyCreated: false, approverJoined: false, approverRole: 'manager', approverActualRole: 'manager', financialYearStart: 3, periodsCreated: 0 }),
    plan: async () => [],
    seed: async () => ({ ran: [], problems: [] }),
    companyProblems: async (_d: ClientBase) => [],
  };
}
const OPTS = { dryRun: false, resetPassword: false, baseUrl: 'http://app.test', envFile: '' };
const gotrueWrites = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-resume-'));
  envFile = join(dir, 'deploy.env');
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test/auth/v1');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('JWT_SECRET', undefined); // a PLAIN run: the wrapper hands these over only when a sign-out is needed
  vi.stubEnv('SUPABASE_ANON_KEY', undefined);
  stubGoTrue();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const pendingOnly = () => writeFileSync(envFile, text('A=1', `${VERIFY_LOGIN.pendingKey}=pend-v`, `${APPROVER_LOGIN.pendingKey}=pend-a`, `${VERIFY_LOGIN.idKey}=id-${VERIFY_LOGIN.email}`), { mode: 0o600 });
const pendingAfterReset = () => writeFileSync(envFile, text('A=1', `${VERIFY_LOGIN.emailKey}=${VERIFY_LOGIN.email}`, `${VERIFY_LOGIN.passwordKey}=old-v`, `${APPROVER_LOGIN.emailKey}=${APPROVER_LOGIN.email}`, `${APPROVER_LOGIN.passwordKey}=old-a`, `${VERIFY_LOGIN.pendingKey}=pend-v`, `${APPROVER_LOGIN.pendingKey}=pend-a`), { mode: 0o600 });

describe('a plain re-run that resumes, with no JWT_SECRET and no anon key in the environment', () => {
  it('after a run that died having only CREATED the logins: sets the saved passwords, ends nothing, publishes, needs no secret', async () => {
    pendingOnly();
    await expect(runProvisioning(OPTS, deps())).resolves.toMatchObject({ wroteEnv: true });
    expect(gotrueWrites().map((c) => `${c.method} ${c.url.replace('http://gotrue.test/auth/v1', '')}`)).toEqual([
      `PUT /admin/users/id-${VERIFY_LOGIN.email}`, `PUT /admin/users/id-${APPROVER_LOGIN.email}`,
    ]);
    const after = readFileSync(envFile, 'utf8');
    expect(after).toContain(`${VERIFY_LOGIN.passwordKey}=pend-v`);
    expect(after).not.toContain('PENDING');
  });

  it('after a RESET that died: refused BEFORE any GoTrue write or env change, naming what is missing (fail closed)', async () => {
    pendingAfterReset();
    const before = readFileSync(envFile, 'utf8');
    await expect(runProvisioning(OPTS, deps())).rejects.toThrow(/must be signed out.*JWT_SECRET and SUPABASE_ANON_KEY.*nothing was changed/s);
    expect(gotrueWrites()).toEqual([]);
    expect(readFileSync(envFile, 'utf8')).toBe(before);
  });

  it('after a RESET that died, WITH the secrets (what the wrapper passes when a pending line exists): sets the password, then really signs out through GoTrue', async () => {
    pendingAfterReset();
    vi.stubEnv('JWT_SECRET', 'j'.repeat(40));
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
    await expect(runProvisioning(OPTS, deps())).resolves.toMatchObject({ wroteEnv: true });
    const w = gotrueWrites().map((c) => `${c.method} ${c.url.replace('http://gotrue.test/auth/v1', '')}`);
    expect(w.filter((x) => x.startsWith('PUT'))).toHaveLength(2);
    expect(w.filter((x) => x === 'POST /logout?scope=global')).toHaveLength(2);
    expect(gotrueWrites().filter((c) => c.url.includes('/logout')).every((c) => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(c.auth ?? ''))).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain(`${VERIFY_LOGIN.passwordKey}=pend-v`);
  });
});

describe('a --reset-password run', () => {
  it('signs out through the real path when it has the secrets', async () => {
    writeFileSync(envFile, text(`${VERIFY_LOGIN.emailKey}=${VERIFY_LOGIN.email}`, `${VERIFY_LOGIN.passwordKey}=old-v`, `${APPROVER_LOGIN.emailKey}=${APPROVER_LOGIN.email}`, `${APPROVER_LOGIN.passwordKey}=old-a`), { mode: 0o600 });
    vi.stubEnv('JWT_SECRET', 'j'.repeat(40));
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
    await runProvisioning({ ...OPTS, resetPassword: true }, deps());
    expect(gotrueWrites().filter((c) => c.url.includes('/logout'))).toHaveLength(2);
    expect(readFileSync(envFile, 'utf8')).not.toContain('old-v');
  });
});
