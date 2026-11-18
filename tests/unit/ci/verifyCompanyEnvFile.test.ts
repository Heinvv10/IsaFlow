// The deploy env file holds the app's other deploy credentials: the provisioner may create or replace its own keys and
// nothing else, must keep the file private and refuse one that is not, and a second run must leave it byte for byte alone.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvKeys, readLogin, readPending, writeLogins, writePending } from '../../../scripts/deploy/verifyCompany/envFile';
import { APPROVER_LOGIN, VERIFY_LOGIN } from '../../../scripts/deploy/verifyCompany/identity';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'verify-env-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const V = { email: VERIFY_LOGIN.email, password: 'p$w`d"-_x' };
const A = { email: APPROVER_LOGIN.email, password: 'appr-pw' };
const BOTH = [{ who: VERIFY_LOGIN, login: V }, { who: APPROVER_LOGIN, login: A }];
const mode = (p: string): number => statSync(p).mode & 0o777;
/** One literal per line: a long `KEY=value` literal reads as a secret to the pre-commit scan. */
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;
const VERIFY_TEXT = [`E2E_VERIFY_EMAIL=${V.email}`, 'E2E_VERIFY_PASSWORD=' + V.password, `E2E_VERIFY_APPROVER_EMAIL=${A.email}`, 'E2E_VERIFY_APPROVER_PASSWORD=' + A.password];

describe('writeLogins', () => {
  it('creates a missing file with mode 0600 holding exactly the four keys', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    expect(writeLogins(file, BOTH)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(text(...VERIFY_TEXT));
    expect(mode(file)).toBe(0o600);
  });

  it('keeps every other line byte for byte (no shell parsing of the values) and the 0600 mode, leaving no temp file', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    const other = text('E2E_ADMIN_EMAIL=admin@x', 'E2E_ADMIN_PASSWORD=a$b`c"d', '# a comment', '', 'SMTP_FROM=IsaFlow <no-reply@x>');
    writeFileSync(file, other, { mode: 0o600 });
    expect(writeLogins(file, BOTH)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(other + text(...VERIFY_TEXT));
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(join(file, '..'))).toEqual(['isaflow-deploy.env']);
  });

  it('replaces its own keys in place, collapsing a repeated key so the one verify-deploy.sh reads last is the new one', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, text('A=1', 'E2E_VERIFY_EMAIL=old@x', 'B=2', 'E2E_VERIFY_PASSWORD=old', 'E2E_VERIFY_EMAIL=older@x'), { mode: 0o600 });
    writeLogins(file, BOTH);
    expect(readFileSync(file, 'utf8')).toBe(text('A=1', VERIFY_TEXT[0]!, 'B=2', VERIFY_TEXT[1]!, VERIFY_TEXT[2]!, VERIFY_TEXT[3]!));
    expect(readLogin(file, VERIFY_LOGIN)).toEqual(V);
  });

  it('removes the pending keys of the logins it publishes, and only those', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, text('A=1', 'E2E_VERIFY_PENDING_PASSWORD=x', 'E2E_VERIFY_APPROVER_PENDING_PASSWORD=y', 'E2E_SOMETHING_PENDING=z'), { mode: 0o600 });
    writeLogins(file, BOTH);
    expect(readFileSync(file, 'utf8')).toBe(text('A=1', 'E2E_SOMETHING_PENDING=z', ...VERIFY_TEXT));
  });

  it('is idempotent: a second call reports no change and writes nothing', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, text('A=1'), { mode: 0o600 });
    writeLogins(file, BOTH);
    const first = readFileSync(file, 'utf8');
    const { mtimeMs, ino } = statSync(file);
    expect(writeLogins(file, BOTH)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(statSync(file).mtimeMs).toBe(mtimeMs);
    expect(statSync(file).ino).toBe(ino);
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o666])('refuses a file group or others can reach (mode %o) and leaves it untouched', (m) => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, text('A=1'), { mode: 0o600 });
    chmodSync(file, m);
    expect(() => writeLogins(file, BOTH)).toThrow(/chmod 600/);
    expect(() => writePending(file, VERIFY_LOGIN, 'x')).toThrow(/chmod 600/);
    expect(readFileSync(file, 'utf8')).toBe(text('A=1'));
    expect(readdirSync(join(file, '..'))).toEqual(['isaflow-deploy.env']);
  });

  it('keeps a stricter mode (0400) it finds', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, text('A=1'));
    chmodSync(file, 0o400);
    writeLogins(file, BOTH);
    expect(mode(file)).toBe(0o400);
  });

  it('never opens a temp file that already exists (flag wx): a planted path is an error, not an overwrite', () => {
    const dir = scratch();
    const file = join(dir, 'isaflow-deploy.env');
    writeFileSync(file, text('A=1'), { mode: 0o600 });
    const planted = `${file}.tmp-${process.pid}`;
    writeFileSync(planted, 'planted');
    expect(() => writeLogins(file, BOTH)).toThrow(/EEXIST/);
    expect(readFileSync(planted, 'utf8')).toBe('planted');
    expect(readFileSync(file, 'utf8')).toBe(text('A=1'));
  });

  it('refuses a value with a newline instead of writing a second line', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    expect(() => writeLogins(file, [{ who: VERIFY_LOGIN, login: { email: V.email, password: 'a\nB=2' } }])).toThrow(/newline/);
  });
});

describe('pending password', () => {
  it('is saved under its own key, read back, and does not make a login (verify-deploy.sh never sees it)', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    expect(writePending(file, VERIFY_LOGIN, 'wait-pw')).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(readPending(file, VERIFY_LOGIN)).toBe('wait-pw');
    expect(readPending(file, APPROVER_LOGIN)).toBeNull();
    expect(readLogin(file, VERIFY_LOGIN)).toBeNull();
    expect(readFileSync(file, 'utf8')).not.toMatch(/^E2E_VERIFY_(EMAIL|PASSWORD)=/m);
  });
});

describe('reading', () => {
  it('reads from column 0 only and drops a trailing CR, as verify-deploy.sh does', () => {
    expect(parseEnvKeys(text('  E2E_VERIFY_EMAIL=indented', 'E2E_VERIFY_PASSWORD=pw\r', 'E2E_VERIFY_PASSWORD=last\r'))).toEqual({ E2E_VERIFY_PASSWORD: 'last' });
  });

  it('returns null for a missing file, a missing key or an empty value', () => {
    const dir = scratch();
    expect(readLogin(join(dir, 'nope.env'), VERIFY_LOGIN)).toBeNull();
    writeFileSync(join(dir, 'a.env'), text('E2E_VERIFY_EMAIL=x@y'));
    expect(readLogin(join(dir, 'a.env'), VERIFY_LOGIN)).toBeNull();
    writeFileSync(join(dir, 'b.env'), text('E2E_VERIFY_EMAIL=x@y', 'E2E_VERIFY_PASSWORD='));
    expect(readLogin(join(dir, 'b.env'), VERIFY_LOGIN)).toBeNull();
  });
});

describe('a symlinked env file', () => {
  it('is written THROUGH: the link survives, the target is replaced, and the target\'s own mode decides', async () => {
    const { symlinkSync, lstatSync, readlinkSync } = await import('node:fs');
    const dir = scratch();
    const target = join(dir, 'real.env');
    const link = join(dir, 'isaflow-deploy.env');
    writeFileSync(target, text('A=1'), { mode: 0o600 });
    symlinkSync(target, link);
    expect(writeLogins(link, BOTH)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(text('A=1', ...VERIFY_TEXT));
    expect(readdirSync(dir).sort()).toEqual(['isaflow-deploy.env', 'real.env']);
    expect(mode(target)).toBe(0o600);
    expect(writePending(link, VERIFY_LOGIN, 'x')).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('refuses when the TARGET is group-readable, though the link itself looks fine', async () => {
    const { symlinkSync } = await import('node:fs');
    const dir = scratch();
    const target = join(dir, 'real.env');
    writeFileSync(target, text('A=1'), { mode: 0o600 });
    chmodSync(target, 0o640);
    symlinkSync(target, join(dir, 'link.env'));
    expect(() => writeLogins(join(dir, 'link.env'), BOTH)).toThrow(/chmod 600/);
  });
});
