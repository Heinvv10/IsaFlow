// ENCRYPTION_KEY is required — the app must not start without encryption configured.
// All fields encrypted at rest (tokens, secrets) depend on this key being present.
// PORTAL_JWT_SECRET added (pentest L3) — used by both AFS portal and legacy AR
// portal (post-H1 migration) for session token signing.
// PLATFORM_ADMIN_DATABASE_URL added (pentest L5) — the admin pool connects as
// a BYPASSRLS role, so a misconfigured URL must fail at boot, not lazy-throw
// the first time an admin request lands.
// IMPERSONATION_JWT_SECRET added (pentest L1) — dedicated secret for
// short-lived admin-to-tenant impersonation tokens, separate from JWT_SECRET.
// CRON_SECRET added (pentest F-02) — all /api/cron/* endpoints check this header;
// a missing var causes each endpoint to return 500 (fail-closed) but without
// this boot-time assertion a misconfigured deploy silently disables all cron jobs.
const REQUIRED_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'PORTAL_JWT_SECRET',
  'PLATFORM_ADMIN_DATABASE_URL',
  'IMPERSONATION_JWT_SECRET',
  'CRON_SECRET',
] as const;
const RECOMMENDED_VARS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const;
const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function assertProductionUrl(name: string, expectedHost?: string): void {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required production environment variable: ${name}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL in production; got "${value}"`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`${name} must use https:// in production; got "${value}"`);
  }

  if (LOCALHOSTS.has(parsed.hostname)) {
    throw new Error(`${name} must not point at localhost in production; got "${value}"`);
  }

  if (expectedHost && parsed.hostname !== expectedHost) {
    throw new Error(`${name} must point at ${expectedHost} in production; got "${value}"`);
  }
}

// 2026-08-09 incident: prod's PLATFORM_ADMIN_DATABASE_URL named `isaflow_dev`
// while DATABASE_URL named `isaflow`. withPlatformAdmin routes every
// /api/admin/* query through the platform-admin pool (lib/neon prefers the ALS
// request client), so the whole admin console read and wrote the dev database
// for ~3.5 months while auth still resolved against prod. A presence check
// cannot catch that — compare the database names the URLs actually target.
// Host and port are deliberately NOT compared: reaching the same database via
// a pooler endpoint on a different port is a legitimate configuration.
const PRIVILEGED_DB_URL_VARS = [
  'PLATFORM_ADMIN_DATABASE_URL',
  'MIGRATION_ADMIN_DATABASE_URL',
] as const;

function databaseNameOf(varName: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${varName} is not a valid database connection URL`);
  }
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) {
    throw new Error(`${varName} does not name a database`);
  }
  return name;
}

function assertPrivilegedPoolsTargetAppDatabase(): void {
  const appDb = databaseNameOf('DATABASE_URL', process.env.DATABASE_URL as string);
  for (const varName of PRIVILEGED_DB_URL_VARS) {
    const value = process.env[varName];
    // MIGRATION_ADMIN_DATABASE_URL is optional; PLATFORM_ADMIN_DATABASE_URL is
    // already guaranteed present by REQUIRED_VARS above.
    if (!value) continue;
    const db = databaseNameOf(varName, value);
    if (db !== appDb) {
      throw new Error(
        `${varName} targets database "${db}" but DATABASE_URL targets "${appDb}" — ` +
          'privileged pools must use the same database as the application.'
      );
    }
  }
}

// M7: secrets must be long enough not to be offline-forgeable. PORTAL/EXTENSION
// secrets are length-checked in their own modules; assert the rest here.
const MIN_SECRET_LEN = 32;
const LENGTH_CHECKED_SECRETS = [
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'IMPERSONATION_JWT_SECRET',
  'CRON_SECRET',
  'PORTAL_JWT_SECRET',
] as const;

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  assertPrivilegedPoolsTargetAppDatabase();
  if (process.env.NODE_ENV === 'production') {
    assertProductionUrl('NEXT_PUBLIC_ADMIN_URL', 'admin.isaflow.co.za');
    // M7: enforce minimum secret strength in production only (dev/test may use
    // short throwaway secrets without blocking local boot).
    const weak = LENGTH_CHECKED_SECRETS.filter(v => (process.env[v] ?? '').length < MIN_SECRET_LEN);
    if (weak.length > 0) {
      throw new Error(`Secret(s) shorter than ${MIN_SECRET_LEN} chars: ${weak.join(', ')}`);
    }
  }
  const missingRecommended = RECOMMENDED_VARS.filter(v => !process.env[v]);
  if (missingRecommended.length > 0) {
    // Use process.stderr to avoid triggering the no-console-log lint rule on warnings
    process.stderr.write(`[env] Missing recommended variables: ${missingRecommended.join(', ')}\n`);
  }
}
