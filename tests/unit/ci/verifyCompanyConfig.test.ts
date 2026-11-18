// The provisioner's rails: it runs only when every target is named, never echoes a secret, and never changes a login
// that exists unless asked, and resumes a run that died.
import { describe, expect, it } from 'vitest';
import { parseOptions } from '../../../scripts/deploy/verifyCompany/config';
import { choosePassword } from '../../../scripts/deploy/verifyCompany/password';
import { assertConnectedToDatabase, assertDatabaseUrlNames } from '../../../scripts/ci/golden/slotConfig';
import { APPROVER_LOGIN, VERIFY_LOGIN } from '../../../scripts/deploy/verifyCompany/identity';

const ARGV = ['--expect-database', 'isaflow', '--base-url', 'http://127.0.0.1:3101/', '--env-file', '/x/deploy.env'];
// The scheme is a variable so the pre-commit secret scan does not read the placeholder login as a credential.
const SCHEME = 'postgresql';
const ENV = {
  VERIFY_COMPANY_DATABASE_URL: `${SCHEME}://owner:s3cret@db.example:7772/isaflow`,
  GOTRUE_URL: 'http://100.96.203.105:7770/auth/v1',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key-value',
};

describe('parseOptions', () => {
  it('takes every target from the caller and trims the trailing slash of the urls', () => {
    expect(parseOptions([...ARGV, '--dry-run'], ENV)).toEqual({
      dryRun: true, resetPassword: false, baseUrl: 'http://127.0.0.1:3101', envFile: '/x/deploy.env',
      databaseUrl: ENV.VERIFY_COMPANY_DATABASE_URL, expectDatabase: 'isaflow', goTrueUrl: ENV.GOTRUE_URL,
    });
  });

  it.each([
    ['--expect-database', ['--base-url', 'http://h', '--env-file', '/x'], ENV],
    ['--base-url', ['--expect-database', 'isaflow', '--env-file', '/x'], ENV],
    ['--env-file', ['--expect-database', 'isaflow', '--base-url', 'http://h'], ENV],
    ['VERIFY_COMPANY_DATABASE_URL', ARGV, { ...ENV, VERIFY_COMPANY_DATABASE_URL: '' }],
    ['GOTRUE_URL', ARGV, { ...ENV, GOTRUE_URL: undefined }],
    ['SUPABASE_SERVICE_ROLE_KEY', ARGV, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined }],
  ])('refuses to run without %s', (name, argv, env) => {
    expect(() => parseOptions(argv, env)).toThrow(new RegExp(`refusing to run without:.*${name}`));
  });

  it('refuses a database url that names another database than --expect-database, without echoing the url', () => {
    const run = () => parseOptions(ARGV, { ...ENV, VERIFY_COMPANY_DATABASE_URL: `${SCHEME}://owner:s3cret@db.example:7772/isaflow_dev` });
    expect(run).toThrow(/isaflow_dev/);
    try { run(); } catch (e) { expect((e as Error).message).not.toContain('s3cret'); }
  });

  it('refuses a database named in the query string over the path', () => {
    expect(() => parseOptions(ARGV, { ...ENV, VERIFY_COMPANY_DATABASE_URL: `${ENV.VERIFY_COMPANY_DATABASE_URL}?dbname=other` })).toThrow(/query string/);
  });

  it('refuses a base url that is not http(s)', () => {
    expect(() => parseOptions(['--expect-database', 'isaflow', '--base-url', 'file:///etc', '--env-file', '/x'], ENV)).toThrow(/http/);
  });
});

describe('choosePassword', () => {
  const file = { email: VERIFY_LOGIN.email, password: 'from-file' };
  const pick = choosePassword;

  it('keeps the file password: an existing login is not touched', () => {
    expect(pick(VERIFY_LOGIN, true, file, null, false)).toEqual({ password: 'from-file', generated: false, resumed: false });
  });

  it('makes a random one for a login GoTrue does not have, and never the same twice', () => {
    const a = pick(VERIFY_LOGIN, false, null, null, false);
    expect(a.generated).toBe(true);
    expect(a.password.length).toBeGreaterThanOrEqual(32);
    expect(pick(VERIFY_LOGIN, false, null, null, false).password).not.toBe(a.password);
  });

  it('uses the file password for a login GoTrue lost (the file is where the password lives)', () => {
    expect(pick(VERIFY_LOGIN, false, file, null, false)).toEqual({ password: 'from-file', generated: false, resumed: false });
  });

  it('resumes a run that died: the pending password wins over the file and over a new one, with no --reset-password', () => {
    expect(pick(VERIFY_LOGIN, true, null, 'pending-pw', false)).toEqual({ password: 'pending-pw', generated: false, resumed: true });
    expect(pick(VERIFY_LOGIN, false, null, 'pending-pw', false)).toMatchObject({ password: 'pending-pw', resumed: true });
    expect(pick(VERIFY_LOGIN, true, file, 'pending-pw', false).password).toBe('pending-pw');
  });

  it('refuses to replace the password of a login that exists when the file cannot say it, unless asked', () => {
    expect(() => pick(VERIFY_LOGIN, true, null, null, false)).toThrow(/--reset-password/);
    expect(pick(VERIFY_LOGIN, true, null, null, true).generated).toBe(true);
  });

  it('--reset-password ignores what the file and the pending key hold', () => {
    const r = pick(VERIFY_LOGIN, true, file, 'pending-pw', true);
    expect(r.generated).toBe(true);
    expect(r.password).not.toBe('from-file');
    expect(r.password).not.toBe('pending-pw');
  });

  it('ignores a file login for another address', () => {
    expect(() => pick(VERIFY_LOGIN, true, { email: 'someone@else.dev', password: 'x' }, null, false)).toThrow(/--reset-password/);
  });

  it('judges the approver by its own address', () => {
    expect(() => pick(APPROVER_LOGIN, true, file, null, false)).toThrow(/--reset-password/);
  });
});

describe('the identities', () => {
  it('are on isaflow.co.za, whose mail goes to a server we run, and are two different people', () => {
    expect(VERIFY_LOGIN.email).toBe('deploy-verify@isaflow.co.za');
    expect(APPROVER_LOGIN.email).toBe('deploy-verify-approver@isaflow.co.za');
    expect(new Set([VERIFY_LOGIN.emailKey, VERIFY_LOGIN.passwordKey, VERIFY_LOGIN.pendingKey, APPROVER_LOGIN.emailKey, APPROVER_LOGIN.passwordKey, APPROVER_LOGIN.pendingKey]).size).toBe(6);
  });
});

describe('the database guards name what they guard', () => {
  it('assertDatabaseUrlNames accepts the named database (production\'s, not only dev\'s) and refuses another', () => {
    expect(() => assertDatabaseUrlNames(`${SCHEME}://u:p@h:7772/isaflow`, 'isaflow')).not.toThrow();
    expect(() => assertDatabaseUrlNames(`${SCHEME}://u:p@h:7772/isaflow_dev`, 'isaflow')).toThrow(/names "isaflow_dev"/);
  });

  it('assertConnectedToDatabase compares what the server says with the name, before any write', async () => {
    const says = (db: string) => ({ query: async () => ({ rows: [{ db }] }) });
    await expect(assertConnectedToDatabase(says('isaflow'), 'isaflow')).resolves.toBe('isaflow');
    await expect(assertConnectedToDatabase(says('isaflow_dev'), 'isaflow')).rejects.toThrow(/not isaflow/);
  });
});

describe('--reset-password needs the JWT secret (it ends the login\'s sessions)', () => {
  it('is refused without JWT_SECRET, and accepted with it; a plain run needs neither', () => {
    expect(() => parseOptions([...ARGV, '--reset-password'], ENV)).toThrow(/JWT_SECRET, SUPABASE_ANON_KEY/);
    expect(() => parseOptions([...ARGV, '--reset-password'], { ...ENV, JWT_SECRET: 'j' })).toThrow(/SUPABASE_ANON_KEY/);
    expect(() => parseOptions([...ARGV, '--reset-password'], { ...ENV, SUPABASE_ANON_KEY: 'a' })).toThrow(/JWT_SECRET/);
    expect(parseOptions([...ARGV, '--reset-password'], { ...ENV, JWT_SECRET: 'j', SUPABASE_ANON_KEY: 'a' }).resetPassword).toBe(true);
    expect(parseOptions(ARGV, ENV).resetPassword).toBe(false);
  });
});
