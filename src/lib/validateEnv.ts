// ENCRYPTION_KEY is required — the app must not start without encryption configured.
// All fields encrypted at rest (tokens, secrets) depend on this key being present.
// PORTAL_JWT_SECRET added (pentest L3) — used by both AFS portal and legacy AR
// portal (post-H1 migration) for session token signing.
// PLATFORM_ADMIN_DATABASE_URL added (pentest L5) — the admin pool connects as
// a BYPASSRLS role, so a misconfigured URL must fail at boot, not lazy-throw
// the first time an admin request lands.
// IMPERSONATION_JWT_SECRET added (pentest L1) — dedicated secret for
// short-lived admin-to-tenant impersonation tokens, separate from JWT_SECRET.
const REQUIRED_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'PORTAL_JWT_SECRET',
  'PLATFORM_ADMIN_DATABASE_URL',
  'IMPERSONATION_JWT_SECRET',
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

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.NODE_ENV === 'production') {
    assertProductionUrl('NEXT_PUBLIC_ADMIN_URL', 'admin.isaflow.co.za');
  }
  const missingRecommended = RECOMMENDED_VARS.filter(v => !process.env[v]);
  if (missingRecommended.length > 0) {
    // Use process.stderr to avoid triggering the no-console-log lint rule on warnings
    process.stderr.write(`[env] Missing recommended variables: ${missingRecommended.join(', ')}\n`);
  }
}
