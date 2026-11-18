// The wiring of a provisioning run to its real effects (realDeps): each Deps member reaches the right GoTrue admin endpoint, database
// statement, env file and lock file. GoTrue is a stubbed fetch, the database a recording client, the files temp paths.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { realDeps } from '../../../scripts/deploy/verifyCompany/realDeps';
import { APPROVER_LOGIN, LOGIN_PURPOSE, VERIFY_LOGIN } from '../../../scripts/deploy/verifyCompany/identity';
import { ensureUserAndCompany } from '../../../scripts/deploy/verifyCompany/provisionDb';
import { companyProblems } from '../../../scripts/deploy/verifyCompany/readiness';

interface Call { url: string; method: string; body: Record<string, unknown> | null; auth: string | null }
let calls: Call[];
let dir: string;
const said: string[] = [];

function stubGoTrue(users: Array<{ id: string; email: string; user_metadata?: Record<string, unknown> }>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.Authorization ?? null });
    if (url.includes('/admin/users?filter=')) return new Response(JSON.stringify({ users }), { status: 200 });
    if (url.endsWith('/admin/users') && init.method === 'POST') {
      const b = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: 'new-id', email: b.email, app_metadata: b.app_metadata, user_metadata: b.user_metadata }), { status: 200 });
    }
    if (url.includes('/admin/users/') && init.method === 'PUT') return new Response(JSON.stringify({ id: 'x', email: 'x' }), { status: 200 });
    if (url.includes('/logout')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  }));
}

const queries: Array<{ sql: string; params?: unknown[] }> = [];
const fakeDb = { query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params }); return { rows: [{ ok: true }] }; } } as unknown as pg.Client;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-real-'));
  queries.length = 0;
  said.length = 0;
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test/auth/v1');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('JWT_SECRET', 'j'.repeat(40));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const deps = (lockFiles?: string[]) => realDeps(fakeDb, join(dir, 'deploy.env'), 'http://app.test', (l) => said.push(l), lockFiles ?? [join(dir, 'a.lock'), join(dir, 'b.lock')]);

describe('realDeps: GoTrue', () => {
  it('find reads the admin user list and returns the login with its purpose marker (null when absent or not a string)', async () => {
    stubGoTrue([
      { id: 'u1', email: VERIFY_LOGIN.email, app_metadata: { purpose: LOGIN_PURPOSE } },
      { id: 'u2', email: APPROVER_LOGIN.email, app_metadata: { purpose: 7 }, user_metadata: { purpose: LOGIN_PURPOSE } },
    ]);
    const d = deps();
    expect(await d.goTrue.find(VERIFY_LOGIN.email)).toEqual({ id: 'u1', purpose: LOGIN_PURPOSE, legacyPurpose: null });
    // a user_metadata marker (which the user could write) is reported apart and is never the admin-only one
    expect(await d.goTrue.find(APPROVER_LOGIN.email)).toEqual({ id: 'u2', purpose: null, legacyPurpose: LOGIN_PURPOSE });
    expect(await d.goTrue.find('nobody@x')).toBeNull();
    expect(calls[0]).toMatchObject({ method: 'GET', auth: 'Bearer service-key' });
  });

  it('create posts the admin user with the email CONFIRMED, the password and our marker in the ADMIN-ONLY app_metadata, and returns the marker GoTrue echoes', async () => {
    stubGoTrue([]);
    const made = await deps().goTrue.create(VERIFY_LOGIN, 'pw-1');
    expect(made).toEqual({ id: 'new-id', purpose: LOGIN_PURPOSE });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('http://gotrue.test/auth/v1/admin/users');
    expect(post.body).toEqual({ email: VERIFY_LOGIN.email, password: 'pw-1', email_confirm: true, app_metadata: { purpose: LOGIN_PURPOSE } });
  });

  it('stamp migrates an earlier version\'s login to the admin-only marker without touching its password', async () => {
    stubGoTrue([]);
    await deps().goTrue.stamp('u1');
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'http://gotrue.test/auth/v1/admin/users/u1', body: { app_metadata: { purpose: LOGIN_PURPOSE } } });
    expect(calls[0]!.body).not.toHaveProperty('password');
  });

  it('setPassword puts the new password (email stays confirmed); signOut sends a GLOBAL logout with a bearer token', async () => {
    stubGoTrue([]);
    const d = deps();
    await d.goTrue.setPassword('u1', 'pw-2');
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'http://gotrue.test/auth/v1/admin/users/u1', body: { password: 'pw-2', email_confirm: true } });
    await d.goTrue.signOut('u1', VERIFY_LOGIN.email);
    const out = calls.find((c) => c.url.includes('/logout'))!;
    expect(out.url).toBe('http://gotrue.test/auth/v1/logout?scope=global');
    expect(out.method).toBe('POST');
    expect(out.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

describe('realDeps: env file, locks, database', () => {
  it('the env members read and write the file they were built with, through the same pending and final keys', () => {
    const d = deps();
    d.env.writePending(VERIFY_LOGIN, 'wait');
    expect(d.env.readPending(VERIFY_LOGIN)).toBe('wait');
    expect(d.env.writeLogins([{ who: VERIFY_LOGIN, login: { email: VERIFY_LOGIN.email, password: 'final' } }])).toBe(true);
    expect(d.env.readLogin(VERIFY_LOGIN)).toEqual({ email: VERIFY_LOGIN.email, password: 'final' });
    expect(d.env.readPending(VERIFY_LOGIN)).toBeNull();
    d.env.recordId(VERIFY_LOGIN, 'gotrue-id-1');
    expect(d.env.readId(VERIFY_LOGIN)).toBe('gotrue-id-1');
    expect(readFileSync(join(dir, 'deploy.env'), 'utf8')).toContain(`${VERIFY_LOGIN.emailKey}=${VERIFY_LOGIN.email}`);
  });

  it('the deploy locks are the files it was given, held until released (a dry run never calls them)', async () => {
    const files = [join(dir, 'a.lock'), join(dir, 'b.lock')];
    const held = await deps(files).deployLocks.acquire();
    expect(files.map((f) => spawnSync('flock', ['-n', f, 'true']).status)).toEqual([1, 1]);
    await held.release();
    expect(files.map((f) => spawnSync('flock', ['-n', f, 'true']).status)).toEqual([0, 0]);
  });

  it('the run lock is the advisory-lock SQL on the run\'s own connection', async () => {
    const d = deps();
    expect(await d.lock.acquire(fakeDb)).toBe(true);
    await d.lock.release(fakeDb);
    expect(queries.map((q) => q.sql)).toEqual(['SELECT pg_try_advisory_lock(hashtext($1)) AS ok', 'SELECT pg_advisory_unlock(hashtext($1))']);
    expect(queries[0]!.params).toEqual(['provision-verify-company']);
  });

  it('the database, readiness and the database connection are the real ones', () => {
    const d = deps();
    expect(d.ensureDb).toBe(ensureUserAndCompany);
    expect(d.companyProblems).toBe(companyProblems);
    expect(d.db).toBe(fakeDb);
  });
});
