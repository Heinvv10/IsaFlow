/**
 * The inputs the provisioner refuses to run without (scripts/deploy/provision-verify-company.ts). Pure, so
 * tests/unit/ci/verifyCompanyConfig.test.ts can pin them.
 */
import { assertDatabaseUrlNames } from '../../ci/golden/slotConfig';

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
  assertDatabaseUrlNames(databaseUrl, expectDatabase);
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
