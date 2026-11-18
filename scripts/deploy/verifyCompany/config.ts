/**
 * The inputs the provisioner refuses to run without (scripts/deploy/provision-verify-company.ts). Pure, so
 * tests/unit/ci/verifyCompanyConfig.test.ts can pin them.
 */
import { assertDatabaseUrlNames } from '../../ci/golden/slotConfig';
import { PRODUCTION_DATABASE } from './identity';

export interface Options {
  dryRun: boolean;
  resetPassword: boolean;
  baseUrl: string;
  envFile: string;
  databaseUrl: string;
  expectDatabase: string;
  goTrueUrl: string;
  /** Drill-only replacement for the deploy's lock files (PROVISION_LOCK_FILES); undefined in any real run. */
  lockFiles?: string[];
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
  // A reset ends the login's sessions through GoTrue's global logout: a token minted with the app's JWT secret, sent with its anon key.
  // Both are needed BEFORE any password changes, so a reset never stops half way.
  const resetMissing = argv.includes('--reset-password') ? ['JWT_SECRET', 'SUPABASE_ANON_KEY'].filter((k) => !env[k]) : [];
  if (resetMissing.length) throw new Error(`refusing --reset-password without ${resetMissing.join(', ')}: a reset must also end the login's sessions, which needs them`);
  const expectDatabase = option(argv, '--expect-database')!;
  const databaseUrl = env.VERIFY_COMPANY_DATABASE_URL!;
  assertDatabaseUrlNames(databaseUrl, expectDatabase);
  // The deploy locks are what keeps a deploy from logging in mid-run: swapping them out is for a throwaway stack, never production.
  if (env.PROVISION_LOCK_FILES && expectDatabase === PRODUCTION_DATABASE) {
    throw new Error(`refusing PROVISION_LOCK_FILES against the production database (${PRODUCTION_DATABASE}): the deploy locks must be the real ones`);
  }
  return {
    dryRun: argv.includes('--dry-run'),
    resetPassword: argv.includes('--reset-password'),
    baseUrl: httpUrl('--base-url', option(argv, '--base-url')!),
    envFile: option(argv, '--env-file')!,
    databaseUrl,
    expectDatabase,
    goTrueUrl: httpUrl('GOTRUE_URL', env.GOTRUE_URL!),
    lockFiles: env.PROVISION_LOCK_FILES ? env.PROVISION_LOCK_FILES.split(':') : undefined,
  };
}
