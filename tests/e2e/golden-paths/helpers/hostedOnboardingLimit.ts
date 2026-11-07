/**
 * Hosted Golden Paths only: gives the E2E admin back its company-creation allowance before a sandbox is created.
 *
 * POST /api/onboarding/complete-setup admits 10 validated requests per user per hour
 * (`onboarding-setup:<userId>`, pages/api/onboarding/complete-setup.ts). On velo's dev the sandboxes already exist
 * and are only found; a hosted run starts from an empty database, so every distinct sandbox is created inside one
 * ~45-minute run, and the eleventh is refused with 429 RATE_LIMIT (run 42368481614: z9's sandbox, once z12 added the
 * eleventh). The production limit is right for users; this resets that one counter row in the run's throwaway
 * database, which only scripts/ci/golden-hosted/up.sh describes (GOLDEN_HOSTED_* in its admin env file).
 *
 * Without those variables (dev, a post-deploy run against production) this does nothing. It refuses any database
 * that is not on this machine's loopback, so a stray variable can never reach a shared database.
 */
const KEY_PREFIX = 'onboarding-setup:';

export async function resetHostedOnboardingLimit(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const url = env.GOLDEN_HOSTED_DB_URL;
  const adminId = env.GOLDEN_HOSTED_ADMIN_ID;
  if (!url || !adminId) return false;
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
    throw new Error(`GOLDEN_HOSTED_DB_URL must point at the runner's own throwaway database, not ${target.hostname}`);
  }
  // In the URL, not as `password`: pg lets the connection string's (absent) password override that option.
  target.password = env.GOLDEN_HOSTED_PGPASSWORD ?? ''; // the setter percent-encodes
  // Loaded only here, so a run that never sets the variables never loads the driver.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try {
    await client.query('DELETE FROM rate_limit_counters WHERE key = $1', [`${KEY_PREFIX}${adminId}`]);
  } finally {
    await client.end();
  }
  return true;
}
