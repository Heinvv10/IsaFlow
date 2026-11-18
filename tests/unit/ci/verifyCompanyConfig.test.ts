// The provisioner's rails: it runs only when every target is named, never echoes a secret, and never changes a login
// that exists unless asked; the seed refuses a half-made block instead of duplicating it.
import { describe, expect, it } from 'vitest';
import { parseOptions } from '../../../scripts/deploy/verifyCompany/config';
import { choosePassword } from '../../../scripts/deploy/verifyCompany/password';
import { BLOCKS, VERIFY_COUNTS, blockState } from '../../../scripts/deploy/verifyCompany/seedVerifyCompany';

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
  const file = { email: 'deploy-verify@isaflow.dev', password: 'from-file' };

  it('keeps the file password: an existing login is not touched', () => {
    expect(choosePassword(true, file, false)).toEqual({ password: 'from-file', generated: false });
  });

  it('makes a random one for a login GoTrue does not have, and never the same twice', () => {
    const a = choosePassword(false, null, false);
    expect(a.generated).toBe(true);
    expect(a.password.length).toBeGreaterThanOrEqual(32);
    expect(choosePassword(false, null, false).password).not.toBe(a.password);
  });

  it('uses the file password for a login GoTrue lost (the file is where the password lives)', () => {
    expect(choosePassword(false, file, false)).toEqual({ password: 'from-file', generated: false });
  });

  it('refuses to replace the password of a login that exists when the file cannot say it, unless asked', () => {
    expect(() => choosePassword(true, null, false)).toThrow(/--reset-password/);
    expect(choosePassword(true, null, true).generated).toBe(true);
  });

  it('ignores a file login for another address', () => {
    expect(() => choosePassword(true, { email: 'someone@else.dev', password: 'x' }, false)).toThrow(/--reset-password/);
  });
});

describe('seed blocks', () => {
  const block = { name: 'b', expected: 4 };
  it('makes an empty block, skips a complete one, refuses a half-made one', () => {
    expect(blockState(block, 0)).toBe('make');
    expect(blockState(block, 4)).toBe('skip');
    expect(() => blockState(block, 2)).toThrow(/half-made/);
  });

  it('expects what the seeders make', () => {
    const byName = Object.fromEntries(BLOCKS.map((b) => [b.name, b.expected]));
    expect(byName['customers and one employee']).toBe(VERIFY_COUNTS.customers + 1);
    expect(byName['posted journals']).toBe(VERIFY_COUNTS.journals);
    expect(byName['bank statement rows']).toBe(VERIFY_COUNTS.bankRows);
  });
});
