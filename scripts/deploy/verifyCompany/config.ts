/**
 * The Deploy Verification company: what it is called, who logs in to it, and the inputs the provisioner refuses to run
 * without (scripts/deploy/provision-verify-company.ts). Pure, so tests/unit/ci/verifyCompanyConfig.test.ts can pin them.
 */
import { assertDevDatabaseUrl } from '../../ci/golden/slotConfig';

/**
 * The verification login. `.dev` like the other non-human golden logins that exist in the shared GoTrue
 * (golden-slot-n@isaflow.dev, reporting-qa@isaflow.dev): it is never a mailbox, and a password reset sent to it goes nowhere.
 */
export const VERIFY_USER_EMAIL = 'deploy-verify@isaflow.dev';
/** Hidden from platform metrics because is_demo = true; the only membership of the verify login. */
export const VERIFY_COMPANY_NAME = 'Deploy Verification';
/** Dates the periods must cover besides today and its year: the specs post 2026-01 .. 2027-02 and the payroll sandbox month is 2027-02. */
export const PERIOD_ANCHOR_DATES = ['2025-06-01', '2026-06-01', '2027-01-15', '2027-06-01'] as const;

export interface Options {
  dryRun: boolean;
  resetPassword: boolean;
  baseUrl: string;
  envFile: string;
  databaseUrl: string;
  expectDatabase: string;
  goTrueUrl: string;
}

/** The input names, printed in usage and error messages. */
export const REQUIRED = {
  flags: ['--base-url <app url>', '--env-file <deploy env file>', '--expect-database <name>'],
  env: ['VERIFY_COMPANY_DATABASE_URL', 'GOTRUE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
} as const;

function option(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  const v = at >= 0 ? argv[at + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

function httpUrl(label: string, value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`${label} is not a url`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${label} must be http or https`);
  return value.replace(/\/+$/, '');
}

/**
 * Every target is named by the caller: nothing is read from a default file, and the database must be named twice (the url
 * and --expect-database; the server's current_database() is checked against the second after connecting).
 * Errors never echo a value: the database url and the service key are secrets.
 */
export function parseOptions(argv: string[], env: Record<string, string | undefined>): Options {
  const missing = [
    ...REQUIRED.flags.filter((f) => option(argv, f.split(' ')[0]!) === undefined),
    ...REQUIRED.env.filter((k) => !env[k]),
  ];
  if (missing.length) throw new Error(`refusing to run without: ${missing.join(', ')}`);
  const expectDatabase = option(argv, '--expect-database')!;
  const databaseUrl = env.VERIFY_COMPANY_DATABASE_URL!;
  assertDevDatabaseUrl(databaseUrl, expectDatabase);
  return {
    dryRun: argv.includes('--dry-run'),
    resetPassword: argv.includes('--reset-password'),
    baseUrl: httpUrl('--base-url', option(argv, '--base-url')!),
    envFile: option(argv, '--env-file')!,
    databaseUrl,
    expectDatabase,
    goTrueUrl: httpUrl('GOTRUE_URL', env.GOTRUE_URL!),
  };
}
