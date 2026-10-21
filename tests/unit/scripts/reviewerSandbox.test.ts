/**
 * Reviewer sandbox seed script (scripts/sandbox/reviewer-sandbox.ts): guards,
 * dry run, and secret handling. No database: the identity and books halves
 * are faked through runSandbox's deps; their real behaviour is covered by
 * tests/integration/reviewer-sandbox.int.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIRM_VALUE, plannedActions, runSandbox, type SandboxDeps } from '../../../scripts/sandbox/reviewer-sandbox';
import {
  SandboxGuardError,
  assertFictionalNames,
  assertNoForeignMembership,
  assertOutsideRepo,
  assertReviewerShape,
  assertSandboxCompanyRow,
  generatePassword,
  parseMode,
  writeCredentialsFile,
} from '../../../scripts/sandbox/reviewerSandboxGuards';
import { SANDBOX_COMPANY, allSandboxNames } from '../../../scripts/sandbox/reviewerSandboxData';

const SANDBOX = SANDBOX_COMPANY.id;
// A run-time marker standing in for the generated credential; if it ever
// shows up in captured stdout, the script printed a secret.
const MARKER = `marker-${randomUUID()}`;
const WRITE_ENV = {
  REVIEWER_SANDBOX_CONFIRM: CONFIRM_VALUE,
  SANDBOX_OPERATOR_USER_ID: 'operator-1',
  DATABASE_URL: 'postgres://unused', GOTRUE_URL: 'http://unused', SUPABASE_SERVICE_ROLE_KEY: 'unused',
};

function fakeDeps(env: Record<string, string> = {}, reviewerExists = false) {
  const lines: string[] = [];
  const identity = {
    preflight: vi.fn(async () => ({ companyExists: false, reviewerUserId: reviewerExists ? 'rev-1' : null })),
    ensureCompany: vi.fn(async () => undefined),
    ensureReviewer: vi.fn(async (_s: unknown, _e: string, np: () => string) => (
      reviewerExists ? { userId: 'rev-1', password: null } : { userId: 'rev-1', password: np() })),
    enableConnector: vi.fn(async () => undefined),
    assertReviewer: vi.fn(async () => undefined),
    rotatePassword: vi.fn(async (_u: string, np: () => string) => np()),
    teardown: vi.fn(async () => ['revoked 0 OAuth authorisation(s)']),
  };
  const seedBooks = vi.fn(async () => undefined);
  const load = vi.fn(async () => ({ sql: vi.fn() as never, identity, seedBooks }));
  const writeCredentials = vi.fn((path: string) => path);
  const deps: SandboxDeps = {
    env, today: new Date('2026-10-20T00:00:00Z'), repoRoot: process.cwd(),
    out: (l) => lines.push(l), load, newPassword: () => MARKER, writeCredentials,
  };
  return { deps, lines, identity, seedBooks, load, writeCredentials };
}

describe('guards', () => {
  it('parseMode: dry run by default; one write mode; unknown flags refuse', () => {
    expect(parseMode([])).toBe('dry-run');
    expect(parseMode(['--apply'])).toBe('apply');
    expect(() => parseMode(['--apply', '--teardown'])).toThrow(SandboxGuardError);
    expect(() => parseMode(['--force'])).toThrow(SandboxGuardError);
  });

  it('guard 1: refuses a company at the sandbox id that is not the sandbox', () => {
    expect(() => assertSandboxCompanyRow('Acme Holdings (Pty) Ltd')).toThrow(SandboxGuardError);
    expect(() => assertSandboxCompanyRow(null)).not.toThrow();
    expect(() => assertSandboxCompanyRow(SANDBOX_COMPANY.name)).not.toThrow();
  });

  it('guard 2: refuses a reviewer email linked to any other company', () => {
    expect(() => assertNoForeignMembership(['other-co'], SANDBOX)).toThrow(SandboxGuardError);
    expect(() => assertNoForeignMembership([SANDBOX, 'other-co'], SANDBOX)).toThrow(SandboxGuardError);
    expect(() => assertNoForeignMembership([SANDBOX], SANDBOX)).not.toThrow();
    expect(() => assertNoForeignMembership([], SANDBOX)).not.toThrow();
  });

  it('guard 3: exactly one membership, never an admin platform role', () => {
    expect(() => assertReviewerShape([SANDBOX], SANDBOX, 'viewer')).not.toThrow();
    expect(() => assertReviewerShape([SANDBOX, 'x'], SANDBOX, 'viewer')).toThrow(SandboxGuardError);
    expect(() => assertReviewerShape([], SANDBOX, 'viewer')).toThrow(SandboxGuardError);
    for (const role of ['super_admin', 'admin', null]) {
      expect(() => assertReviewerShape([SANDBOX], SANDBOX, role)).toThrow(SandboxGuardError);
    }
  });

  it('guard 4: refuses names that are not visibly fictional; every fixture passes', () => {
    expect(() => assertFictionalNames(['Highveld Bricks (Pty) Ltd'])).toThrow(SandboxGuardError);
    expect(() => assertFictionalNames(['Demolition Co'])).toThrow(SandboxGuardError); // "Demo" must be a word
    expect(() => assertFictionalNames(allSandboxNames())).not.toThrow();
  });

  it('credentials stay outside the repository', () => {
    expect(() => assertOutsideRepo(join(process.cwd(), 'creds.json'), process.cwd())).toThrow(SandboxGuardError);
    expect(() => assertOutsideRepo(join(tmpdir(), 'creds.json'), process.cwd())).not.toThrow();
  });

  it('generatePassword is random, URL-safe and at least 24 characters', () => {
    const a = generatePassword();
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generatePassword()).not.toBe(a);
  });

  it('writeCredentialsFile writes the secret to the file only, mode 0600 where the OS supports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-creds-'));
    const path = writeCredentialsFile(join(dir, 'creds'), process.cwd(), 'r@example.com', MARKER);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ email: 'r@example.com', password: MARKER });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('runSandbox', () => {
  it('dry run (the default) writes nothing and loads no database code', async () => {
    const f = fakeDeps(WRITE_ENV);
    expect(await runSandbox([], f.deps)).toBe('dry-run');
    expect(f.load).not.toHaveBeenCalled();
    expect(f.writeCredentials).not.toHaveBeenCalled();
    expect(f.lines.join('\n')).toContain('DRY RUN');
    expect(f.lines.join('\n')).toContain(plannedActions('marketplace-review@isaflow.co.za')[0]);
  });

  it('write modes refuse without the confirmation and operator, before loading anything', async () => {
    for (const env of [{}, { ...WRITE_ENV, REVIEWER_SANDBOX_CONFIRM: 'yes' }, { ...WRITE_ENV, SANDBOX_OPERATOR_USER_ID: '' }]) {
      const f = fakeDeps(env);
      await expect(runSandbox(['--apply'], f.deps)).rejects.toThrow(SandboxGuardError);
      expect(f.load).not.toHaveBeenCalled();
    }
  });

  it('apply: guards first, credentials to the file, password never in stdout', async () => {
    const f = fakeDeps(WRITE_ENV);
    await runSandbox(['--apply'], f.deps);
    expect(f.identity.preflight).toHaveBeenCalledBefore(f.identity.ensureCompany);
    expect(f.writeCredentials).toHaveBeenCalledWith(expect.any(String), process.cwd(), 'marketplace-review@isaflow.co.za', MARKER);
    expect(f.identity.assertReviewer).toHaveBeenCalledWith(expect.anything(), 'rev-1');
    expect(f.lines.join('\n')).not.toContain(MARKER);
  });

  it('a re-run of apply does not rotate the password', async () => {
    const f = fakeDeps(WRITE_ENV, true);
    await runSandbox(['--apply'], f.deps);
    expect(f.writeCredentials).not.toHaveBeenCalled();
    expect(f.lines.join('\n')).toContain('password left unchanged');
  });

  it('rotate-password rewrites the file and never prints the password', async () => {
    const f = fakeDeps(WRITE_ENV, true);
    await runSandbox(['--rotate-password'], f.deps);
    expect(f.identity.rotatePassword).toHaveBeenCalledWith('rev-1', expect.any(Function));
    expect(f.writeCredentials).toHaveBeenCalledTimes(1);
    expect(f.lines.join('\n')).not.toContain(MARKER);
  });

  it('a guard refusal in preflight stops before any write', async () => {
    const f = fakeDeps(WRITE_ENV);
    f.identity.preflight.mockRejectedValueOnce(new SandboxGuardError('foreign membership'));
    await expect(runSandbox(['--apply'], f.deps)).rejects.toThrow('foreign membership');
    expect(f.identity.ensureCompany).not.toHaveBeenCalled();
    expect(f.identity.ensureReviewer).not.toHaveBeenCalled();
  });
});

describe('guard 5: no secret printing in the sandbox scripts', () => {
  it('no console call or out() line interpolates a password', () => {
    const dir = join(process.cwd(), 'scripts', 'sandbox');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/console\.(log|info|warn|error)\([^)]*password/i);
      expect(text, file).not.toMatch(/(say|out)\([^)]*\$\{[^}]*password/i);
    }
  });
});
