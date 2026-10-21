/**
 * Guards and credential handling for the reviewer sandbox. Pure (no database,
 * no network), so tests/unit/scripts/reviewerSandbox.test.ts can prove every
 * refusal without a connection.
 *
 * The five guards of sandbox-plan.md, all checked BEFORE any write:
 *  1. the deterministic company id, if it exists, must carry the sandbox name;
 *  2. the reviewer email, if it exists, must belong to no other company;
 *  3. after apply: exactly one company_users row, platform role not admin;
 *  4. every name written must be visibly fictional;
 *  5. the password is never printed (it only ever goes to a 0600 file).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SANDBOX_NAME_PREFIX } from './reviewerSandboxData';

export type SandboxMode = 'dry-run' | 'apply' | 'rotate-password' | 'teardown';

export class SandboxGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxGuardError';
  }
}

/** Dry run unless exactly one write mode is asked for. Unknown flags refuse. */
export function parseMode(argv: readonly string[]): SandboxMode {
  const known: Record<string, SandboxMode> = {
    '--dry-run': 'dry-run',
    '--apply': 'apply',
    '--rotate-password': 'rotate-password',
    '--teardown': 'teardown',
  };
  const flags = argv.filter((a) => a.startsWith('--'));
  for (const f of flags) {
    if (!(f in known)) throw new SandboxGuardError(`Unknown flag ${f}`);
  }
  const modes = [...new Set(flags.map((f) => known[f]!))];
  if (modes.length > 1) throw new SandboxGuardError(`Pick one mode, got ${modes.join(', ')}`);
  return modes[0] ?? 'dry-run';
}

/** Guard 4: a name is written only if it is visibly fictional. */
export function assertFictionalNames(names: readonly string[]): void {
  const bad = names.filter((n) => !n.includes('(Fictional)') && !/\bDemo\b/.test(n));
  if (bad.length > 0) {
    throw new SandboxGuardError(`Refusing non-fictional name(s): ${bad.join('; ')}`);
  }
}

/** Guard 1: the row at the sandbox id, if any, must be the sandbox. */
export function assertSandboxCompanyRow(existingName: string | null): void {
  if (existingName !== null && !existingName.startsWith(SANDBOX_NAME_PREFIX)) {
    throw new SandboxGuardError(
      `Company id is taken by a company not named "${SANDBOX_NAME_PREFIX}…"; refusing to touch it`,
    );
  }
}

/** Guard 2: the reviewer may already exist only as a member of the sandbox. */
export function assertNoForeignMembership(memberCompanyIds: readonly string[], sandboxCompanyId: string): void {
  const foreign = memberCompanyIds.filter((id) => id !== sandboxCompanyId);
  if (foreign.length > 0) {
    throw new SandboxGuardError(
      `Reviewer email already belongs to ${foreign.length} other company(ies); refusing to reuse it`,
    );
  }
}

const ADMIN_PLATFORM_ROLES = new Set(['super_admin', 'admin', 'platform_admin', 'support_admin']);

/** Guard 3: after apply, the reviewer reaches exactly one company and is not an admin. */
export function assertReviewerShape(memberCompanyIds: readonly string[], sandboxCompanyId: string, platformRole: string | null): void {
  if (memberCompanyIds.length !== 1 || memberCompanyIds[0] !== sandboxCompanyId) {
    throw new SandboxGuardError(
      `Reviewer must belong to exactly the sandbox company; found ${memberCompanyIds.length} membership(s)`,
    );
  }
  if (platformRole === null || ADMIN_PLATFORM_ROLES.has(platformRole)) {
    throw new SandboxGuardError(`Reviewer platform role must be a non-admin role; found ${platformRole ?? 'none'}`);
  }
}

/** 24 random bytes → 32 URL-safe characters. Generated at run time, never stored in the repo. */
export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

export function defaultCredentialsPath(): string {
  return join(homedir(), '.isaflow-reviewer-credentials');
}

/** The credential file must live outside the repository, so it can never be committed. */
export function assertOutsideRepo(path: string, repoRoot: string): void {
  const p = resolve(path);
  const root = resolve(repoRoot);
  if (p === root || p.startsWith(root + sep)) {
    throw new SandboxGuardError('Refusing to write credentials inside the repository');
  }
}

/**
 * Guard 5's other half: the only place the password goes. Mode 0600, written
 * fresh each time. Returns the PATH, which is all the caller may print.
 */
export function writeCredentialsFile(path: string, repoRoot: string, email: string, password: string): string {
  assertOutsideRepo(path, repoRoot);
  const body = JSON.stringify({ email, password, createdAt: new Date().toISOString() }, null, 2);
  writeFileSync(path, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode applies only on create; tighten an existing file too.
  chmodSync(path, 0o600);
  return path;
}

/** Build a run-time date `daysAgo` days before `today`, as YYYY-MM-DD. */
export function isoDaysAgo(today: Date, daysAgo: number): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
