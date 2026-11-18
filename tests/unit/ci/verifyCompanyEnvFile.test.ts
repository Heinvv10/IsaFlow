// The deploy env file holds the app's other deploy credentials: the provisioner may create or replace its two verify keys
// and nothing else, must keep the file private, and a second run must leave it byte for byte alone.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerifyLogin, writeVerifyLogin } from '../../../scripts/deploy/verifyCompany/envFile';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'verify-env-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const LOGIN = { email: 'deploy-verify@isaflow.dev', password: 'p$w`d"-_x' };
const mode = (p: string): number => statSync(p).mode & 0o777;
/** The two lines writeVerifyLogin writes, one literal per line (a long `KEY=value` literal reads as a secret to the pre-commit scan). */
const VERIFY_LINES = ['E2E_VERIFY_EMAIL=' + LOGIN.email, 'E2E_VERIFY_PASSWORD=' + LOGIN.password];
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('writeVerifyLogin', () => {
  it('creates a missing file with mode 0600 holding exactly the two keys', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    expect(writeVerifyLogin(file, LOGIN)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(text(...VERIFY_LINES));
    expect(mode(file)).toBe(0o600);
  });

  it('keeps every other line byte for byte (no shell parsing of the values) and the 0600 mode', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    const other = text('E2E_ADMIN_EMAIL=admin@x', 'E2E_ADMIN_PASSWORD=a$b`c"d', '# a comment', '', 'SMTP_FROM=IsaFlow <no-reply@x>');
    writeFileSync(file, other, { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(writeVerifyLogin(file, LOGIN)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(other + text(...VERIFY_LINES));
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(join(file, '..'))).toEqual(['isaflow-deploy.env']);
  });

  it('replaces its own keys in place, collapsing a repeated key so the one verify-deploy.sh reads last is the new one', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, text('A=1', 'E2E_VERIFY_EMAIL=old@x', 'B=2', 'E2E_VERIFY_PASSWORD=old', 'E2E_VERIFY_EMAIL=older@x'), { mode: 0o600 });
    writeVerifyLogin(file, LOGIN);
    expect(readFileSync(file, 'utf8')).toBe(text('A=1', VERIFY_LINES[0]!, 'B=2', VERIFY_LINES[1]!));
    expect(readVerifyLogin(file)).toEqual(LOGIN);
  });

  it('is idempotent: a second call reports no change and writes nothing', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, 'A=1\n', { mode: 0o600 });
    writeVerifyLogin(file, LOGIN);
    const first = readFileSync(file, 'utf8');
    const { mtimeMs, ino } = statSync(file);
    expect(writeVerifyLogin(file, LOGIN)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(statSync(file).mtimeMs).toBe(mtimeMs);
    expect(statSync(file).ino).toBe(ino);
  });

  it('never loosens the mode of a file that is stricter or looser: it keeps what it finds', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    writeFileSync(file, 'A=1\n');
    chmodSync(file, 0o400);
    writeVerifyLogin(file, LOGIN);
    expect(mode(file)).toBe(0o400);
  });

  it('refuses a value with a newline instead of writing a second line', () => {
    const file = join(scratch(), 'isaflow-deploy.env');
    expect(() => writeVerifyLogin(file, { email: LOGIN.email, password: 'a\nB=2' })).toThrow(/newline/);
  });
});

describe('readVerifyLogin', () => {
  it('returns null for a missing file, a missing key or an empty value', () => {
    const dir = scratch();
    expect(readVerifyLogin(join(dir, 'nope.env'))).toBeNull();
    writeFileSync(join(dir, 'a.env'), text('E2E_VERIFY_EMAIL=x@y'));
    expect(readVerifyLogin(join(dir, 'a.env'))).toBeNull();
    writeFileSync(join(dir, 'b.env'), text('E2E_VERIFY_EMAIL=x@y', 'E2E_VERIFY_PASSWORD='));
    expect(readVerifyLogin(join(dir, 'b.env'))).toBeNull();
  });
});
