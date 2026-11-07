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
 * Without those variables (dev, a post-deploy run against production) this does nothing. With them, it deletes
 * only when every one of these holds, and otherwise throws without connecting or deleting:
 *   - it runs on a GitHub-hosted runner (GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted);
 *   - the URL's host is loopback and its database is up.sh's APP_DB, `isaflow_golden`;
 *   - the server it reached says so too (current_database()).
 * Loopback alone is no guard: on velo, isaflow_dev's Postgres (and others) listen on 0.0.0.0, so 127.0.0.1 reaches
 * them. A runner check plus the database name is what keeps a stray variable away from a shared database.
 */
const KEY_PREFIX = 'onboarding-setup:';
/** up.sh's APP_DB. */
export const HOSTED_GOLDEN_DB = 'isaflow_golden';

export async function resetHostedOnboardingLimit(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const url = env.GOLDEN_HOSTED_DB_URL;
  const adminId = env.GOLDEN_HOSTED_ADMIN_ID;
  if (!url || !adminId) return false;
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('GOLDEN_HOSTED_* is set outside a GitHub-hosted runner; refusing to touch any database');
  }
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
    throw new Error(`GOLDEN_HOSTED_DB_URL must point at the runner's own throwaway database, not ${target.hostname}`);
  }
  if (target.pathname !== `/${HOSTED_GOLDEN_DB}`) {
    throw new Error(`GOLDEN_HOSTED_DB_URL must name the database ${HOSTED_GOLDEN_DB}, not ${target.pathname}`);
  }
  // In the URL, not as `password`: pg lets the connection string's (absent) password override that option.
  target.password = env.GOLDEN_HOSTED_PGPASSWORD ?? ''; // the setter percent-encodes
  // Loaded only here, so a run that never sets the variables never loads the driver.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    if (rows[0]?.db !== HOSTED_GOLDEN_DB) {
      throw new Error(`connected to ${rows[0]?.db ?? 'no database'}, not ${HOSTED_GOLDEN_DB}; nothing deleted`);
    }
    await client.query('DELETE FROM rate_limit_counters WHERE key = $1', [`${KEY_PREFIX}${adminId}`]);
  } finally {
    await client.end();
  }
  return true;
}
