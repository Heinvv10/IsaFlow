/**
 * The rubric harness's runtime checks and logins (master plan wave 4, MW). Feeds the pure guard (_rubricGuard.ts).
 *
 * The server tree is not configured, it is found: the one process listening on the port, and its working directory.
 * Its `.env.local` names the database the server writes to, so that is the DATABASE_URL the guard judges (the "before"
 * run serves the base-SHA tree, whose .env.local is not this worktree's).
 *
 * The approver is added to the sandbox with one INSERT on that database (isaflow_dev only, judged above). The app's only
 * way to add a member is an invitation, and an invitation sends a real email from dev's live SMTP (rule 10). The golden
 * slot provisioning (scripts/ci/golden/slotProvision.ts) adds its members the same way. The requester's starting company
 * is read there too, so each user logs in once per run.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { Api } from '../golden-paths/_api';
import { findOrCreateSandbox, switchApiCompany } from '../golden-paths/_migrationSandbox';
import {
  APPROVER_EMAIL, REQUESTER_EMAIL, RubricGuardError, assertBaseUrl, assertDevDatabase, assertLogins, assertRunId,
  assertSession, listenerPids, parseEnvFile, sandboxName, type MeView,
} from './_rubricGuard';

export interface Creds { email: string; password: string }

export interface RubricEnv {
  baseURL: string;
  port: number;
  serverDir: string;
  serverHead: string;
  databaseUrl: string;
  runId: string;
  evidenceDir: string;
  requester: Creds;
  approver: Creds;
}

function readCreds(file: string, emailKey: string, passwordKey: string): Creds {
  const env = parseEnvFile(readFileSync(file, 'utf8'));
  return { email: env[emailKey] ?? '', password: env[passwordKey] ?? '' };
}

/** The working directory of the one process listening on `port`. */
export function serverDirOf(port: number): string {
  const ss = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  const pids = listenerPids(ss, port);
  if (pids.length !== 1) throw new RubricGuardError(`expected one process listening on :${port}, found ${pids.length}`);
  return readlinkSync(`/proc/${pids[0]}/cwd`);
}

/** Every check that needs no login. Throws before any request reaches the server. */
export function checkEnvironment(baseURL: string | undefined): RubricEnv {
  const port = assertBaseUrl(baseURL);
  const runId = assertRunId(process.env.RUBRIC_RUN_ID);
  const evidenceDir = process.env.RUBRIC_EVIDENCE_DIR;
  if (!evidenceDir) throw new RubricGuardError('RUBRIC_EVIDENCE_DIR is required');
  const serverDir = serverDirOf(port);
  const databaseUrl = parseEnvFile(readFileSync(join(serverDir, '.env.local'), 'utf8')).DATABASE_URL ?? '';
  assertDevDatabase(databaseUrl);
  const secrets = join(homedir(), '.secrets');
  const requester = readCreds(process.env.RUBRIC_REQUESTER_ENV ?? join(secrets, 'isaflow-reporting-qa.env'), 'E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD');
  const approver = readCreds(process.env.RUBRIC_APPROVER_ENV ?? join(secrets, 'isaflow-dev-approver.env'), 'E2E_APPROVER_EMAIL', 'E2E_APPROVER_PASSWORD');
  assertLogins(requester.email, approver.email);
  if (!requester.password || !approver.password) throw new RubricGuardError('a login has no password in its secrets file');
  const serverHead = execFileSync('git', ['-C', serverDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { baseURL: baseURL!, port, serverDir, serverHead, databaseUrl, runId, evidenceDir, requester, approver };
}

export const me = async (api: Api): Promise<MeView> => api.get<MeView>('/api/auth/me');

/** A deterministic RFC 4122 v5-shaped id per run: complete-setup's requestKey makes the sandbox idempotent per run id. */
export function onboardingKey(runId: string): string {
  const h = createHash('sha1').update(`isaflow-rubric:${runId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A connection to the server's database, which the guard has judged to be isaflow_dev (judged again here). */
async function withDevDb<T>(env: RubricEnv, use: (db: Client) => Promise<T>): Promise<T> {
  assertDevDatabase(env.databaseUrl);
  const db = new Client({ connectionString: env.databaseUrl });
  await db.connect();
  try {
    return await use(db);
  } finally {
    await db.end();
  }
}

/**
 * The company the requester's one login opens in: this run's sandbox once it exists, else their default company. Read
 * from the database, so each run logs in once per user (login allows 10 attempts per email per 15 minutes, and peers
 * log in as the same QA user).
 */
async function startingCompany(env: RubricEnv): Promise<string> {
  return withDevDb(env, async (db) => {
    const rows = await db.query<{ company_id: string }>(
      `SELECT cu.company_id FROM company_users cu
       JOIN users u ON u.id::text = cu.user_id JOIN companies c ON c.id = cu.company_id
       WHERE lower(u.email) = $1 AND c.is_active IS NOT FALSE AND c.status = 'active'
       ORDER BY (c.name = $2) DESC, cu.is_default DESC NULLS LAST, cu.created_at LIMIT 1`,
      [REQUESTER_EMAIL, sandboxName(env.runId)]);
    const id = rows.rows[0]?.company_id;
    if (!id) throw new RubricGuardError(`${REQUESTER_EMAIL} has no company to open`);
    return id;
  });
}

export interface Sandbox { id: string; name: string; runId: string }

/** The requester, logged in and scoped to this run's sandbox (made on first use). */
export async function requesterInSandbox(env: RubricEnv): Promise<{ api: Api; sandbox: Sandbox }> {
  const api = await Api.loginAs(env.baseURL, { ...env.requester, companyId: await startingCompany(env) });
  const name = sandboxName(env.runId);
  const id = await findOrCreateSandbox(api, { name, onboardingId: onboardingKey(env.runId) });
  const sandbox = { id, name, runId: env.runId };
  await switchApiCompany(api, id);
  await assertWriteScope(api, REQUESTER_EMAIL, sandbox);
  return { api, sandbox };
}

/** Called before every write: the session is still `email`, in the sandbox. */
export async function assertWriteScope(api: Api, email: string, sandbox: Sandbox): Promise<void> {
  assertSession(await me(api), email, sandbox);
}

/**
 * The approver becomes an admin of the sandbox (admin ranks at the 'admin' a pay_run request demands when no rule binds
 * it). The INSERT names the sandbox by id AND name and excludes Demo, so it cannot land anywhere else.
 */
export async function addApprover(env: RubricEnv, sandbox: Sandbox): Promise<{ role: string; added: boolean }> {
  return withDevDb(env, async (db) => {
    const inserted = await db.query(
      `INSERT INTO company_users (company_id, user_id, role, is_default)
       SELECT c.id, u.id::text, 'admin',
              NOT EXISTS (SELECT 1 FROM company_users d WHERE d.user_id = u.id::text AND d.is_default)
       FROM companies c JOIN users u ON lower(u.email) = $3
       WHERE c.id = $1::uuid AND c.name = $2 AND c.id <> '00000000-0000-0000-0000-000000000001'::uuid
       ON CONFLICT (company_id, user_id) DO NOTHING`,
      [sandbox.id, sandbox.name, APPROVER_EMAIL]);
    const row = await db.query<{ role: string }>(
      `SELECT cu.role FROM company_users cu JOIN users u ON u.id::text = cu.user_id
       WHERE cu.company_id = $1::uuid AND lower(u.email) = $2`, [sandbox.id, APPROVER_EMAIL]);
    const role = row.rows[0]?.role;
    if (role !== 'admin' && role !== 'owner') throw new RubricGuardError(`${APPROVER_EMAIL} is not an owner/admin of the sandbox`);
    return { role, added: (inserted.rowCount ?? 0) > 0 };
  });
}

/** The approver, logged in and scoped to the sandbox. */
export async function approverInSandbox(env: RubricEnv, sandbox: Sandbox): Promise<Api> {
  const api = await Api.loginAs(env.baseURL, { ...env.approver, companyId: sandbox.id });
  await assertWriteScope(api, APPROVER_EMAIL, sandbox);
  return api;
}

/** `uptime`'s load averages, recorded at the start and end of every run (timings count only at load <= 20). */
export function loadAverage(): string {
  return execFileSync('uptime', { encoding: 'utf8' }).trim();
}
