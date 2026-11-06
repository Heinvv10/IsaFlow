/**
 * The rubric harness's runtime checks and logins (master plan wave 4, MW). Feeds the pure guard (_rubricGuard.ts).
 *
 * The server tree is not configured, it is found: the one process listening on the port (_rubricServerEnv.ts). Every
 * *DATABASE_URL* that server sees (its own env, then its tree's env files, as Next dev loads them) must be dev (the
 * "before" run serves the base-SHA tree, whose env is not this worktree's).
 *
 * The approver is added to the sandbox with one INSERT on that database (isaflow_dev only, judged above). The app's only
 * way to add a member is an invitation, and an invitation sends a real email from dev's live SMTP (rule 10). The golden
 * slot provisioning (scripts/ci/golden/slotProvision.ts) adds its members the same way. The requester's starting company
 * is read there too, so each user logs in once per run.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Api } from '../golden-paths/_api';
import { findOrCreateSandbox, switchApiCompany } from '../golden-paths/_migrationSandbox';
import { insertApprover, startingCompany, withDevDb } from './_rubricDb';
import {
  APPROVER_EMAIL, REQUESTER_EMAIL, RubricGuardError, assertBaseUrl, assertLogins, assertRunId, assertSession, guardWrites,
  parseEnvFile, sandboxName, type MeView,
} from './_rubricGuard';
import { checkServer } from './_rubricServerEnv';

export interface Creds { email: string; password: string }

export interface RubricEnv {
  baseURL: string;
  port: number;
  serverDir: string;
  serverHead: string;
  databaseUrl: string;
  /** Every *DATABASE_URL* key the server sees, each judged dev. */
  databaseKeys: string[];
  runId: string;
  evidenceDir: string;
  requester: Creds;
  approver: Creds;
}

function readCreds(file: string, emailKey: string, passwordKey: string): Creds {
  const env = parseEnvFile(readFileSync(file, 'utf8'));
  return { email: env[emailKey] ?? '', password: env[passwordKey] ?? '' };
}

/** Every check that needs no login. Throws before any request reaches the server. */
export function checkEnvironment(baseURL: string | undefined): RubricEnv {
  const port = assertBaseUrl(baseURL);
  const runId = assertRunId(process.env.RUBRIC_RUN_ID);
  const evidenceDir = process.env.RUBRIC_EVIDENCE_DIR;
  if (!evidenceDir) throw new RubricGuardError('RUBRIC_EVIDENCE_DIR is required');
  const { serverDir, databaseUrl, databaseKeys } = checkServer(port);
  const secrets = join(homedir(), '.secrets');
  const requester = readCreds(process.env.RUBRIC_REQUESTER_ENV ?? join(secrets, 'isaflow-reporting-qa.env'), 'E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD');
  const approver = readCreds(process.env.RUBRIC_APPROVER_ENV ?? join(secrets, 'isaflow-dev-approver.env'), 'E2E_APPROVER_EMAIL', 'E2E_APPROVER_PASSWORD');
  assertLogins(requester.email, approver.email);
  if (!requester.password || !approver.password) throw new RubricGuardError('a login has no password in its secrets file');
  const serverHead = execFileSync('git', ['-C', serverDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { baseURL: baseURL!, port, serverDir, serverHead, databaseUrl, databaseKeys, runId, evidenceDir, requester, approver };
}

export const me = async (api: Api): Promise<MeView> => api.get<MeView>('/api/auth/me');

/** A deterministic RFC 4122 v5-shaped id per run: complete-setup's requestKey makes the sandbox idempotent per run id. */
export function onboardingKey(runId: string): string {
  const h = createHash('sha1').update(`isaflow-rubric:${runId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface Sandbox { id: string; name: string; runId: string }

/** The requester, logged in and scoped to this run's sandbox (made on first use). */
export async function requesterInSandbox(env: RubricEnv): Promise<{ api: Api; sandbox: Sandbox }> {
  const name = sandboxName(env.runId);
  const companyId = await withDevDb(env.databaseUrl, (db) => startingCompany(db, name));
  const api = await Api.loginAs(env.baseURL, { ...env.requester, companyId });
  // The only writes outside the sandbox: making it (complete-setup, idempotent per run id) and switching into it.
  const id = await findOrCreateSandbox(api, { name, onboardingId: onboardingKey(env.runId) });
  const sandbox = { id, name, runId: env.runId };
  await switchApiCompany(api, id);
  return { api: scoped(api, REQUESTER_EMAIL, sandbox), sandbox };
}

/** The session is still `email`, in the sandbox. */
export async function assertWriteScope(api: Api, email: string, sandbox: Sandbox): Promise<void> {
  assertSession(await me(api), email, sandbox);
}

/** From here on, every write through `api` is checked first: never the email route, and the session is in the sandbox. */
function scoped(api: Api, email: string, sandbox: Sandbox): Api {
  return guardWrites(api, () => assertWriteScope(api, email, sandbox));
}

/** The approver becomes an admin of the sandbox: one INSERT on isaflow_dev (_rubricDb.ts insertApprover). */
export async function addApprover(env: RubricEnv, sandbox: Sandbox): Promise<{ role: string; added: boolean }> {
  return withDevDb(env.databaseUrl, (db) => insertApprover(db, sandbox));
}

/** The approver, logged in and scoped to the sandbox. */
export async function approverInSandbox(env: RubricEnv, sandbox: Sandbox): Promise<Api> {
  const api = await Api.loginAs(env.baseURL, { ...env.approver, companyId: sandbox.id });
  await assertWriteScope(api, APPROVER_EMAIL, sandbox);
  return scoped(api, APPROVER_EMAIL, sandbox);
}

/** `uptime`'s load averages, recorded at the start and end of every run (timings count only at load <= 20). */
export function loadAverage(): string {
  return execFileSync('uptime', { encoding: 'utf8' }).trim();
}
