/**
 * Disposable golden stack only (scripts/ci/golden-hosted/up.sh): sets a company's feature-flag override, so a dev-only
 * spec can see a flagged page both ways (z19: the three-way budget with `budgets_three_way` on and off). Feature flags
 * are a platform-admin write (migration 945 made the tables read-only to app roles), so no route can do it.
 *
 * Without GOLDEN_HOSTED_DB_URL (velo's dev, a production verify) `hostedFlagAvailable` is false and nothing connects.
 * With it, a write happens only when EVERY one of these holds, and otherwise it throws without writing:
 *   - a GitHub-hosted runner (GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted), or GOLDEN_HOSTED_LOCAL=1 set by
 *     hand for an up.sh stack on this machine;
 *   - the URL's host is loopback and its database is up.sh's `isaflow_golden` (`HOSTED_GOLDEN_DB`);
 *   - the server it reached says so too (current_database());
 *   - the company is up.sh's seeded one (name "… (Golden Paths CI)"), so a real Demo company is never touched.
 * Loopback alone is no guard on velo (shared Postgres servers listen on 0.0.0.0): see hostedOnboardingLimit.ts.
 */
import { HOSTED_GOLDEN_DB } from './hostedOnboardingLimit';

const SEEDED_COMPANY = /\(Golden Paths CI\)$/;

export function hostedFlagAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOLDEN_HOSTED_DB_URL && env.GOLDEN_HOSTED_ADMIN_ID);
}

/** `enabled: null` deletes the override (the company falls back to plan / global). Returns the override it replaced. */
export async function setHostedFlag(companyId: string, code: string, enabled: boolean | null, env: NodeJS.ProcessEnv = process.env): Promise<boolean | null> {
  const url = env.GOLDEN_HOSTED_DB_URL;
  const adminId = env.GOLDEN_HOSTED_ADMIN_ID;
  if (!url || !adminId) throw new Error('setHostedFlag needs the disposable stack (GOLDEN_HOSTED_DB_URL / GOLDEN_HOSTED_ADMIN_ID)');
  const runner = env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  if (!runner && env.GOLDEN_HOSTED_LOCAL !== '1') throw new Error('GOLDEN_HOSTED_* outside a GitHub-hosted runner without GOLDEN_HOSTED_LOCAL=1; refusing');
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') throw new Error(`not a loopback database: ${target.hostname}`);
  if (target.pathname !== `/${HOSTED_GOLDEN_DB}`) throw new Error(`not ${HOSTED_GOLDEN_DB}: ${target.pathname}`);
  target.password = env.GOLDEN_HOSTED_PGPASSWORD ?? '';
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try {
    const db = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db;
    if (db !== HOSTED_GOLDEN_DB) throw new Error(`connected to ${db ?? 'no database'}, not ${HOSTED_GOLDEN_DB}; nothing written`);
    const co = (await client.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0];
    if (!co || !SEEDED_COMPANY.test(co.name)) throw new Error(`company ${companyId} is not the stack's seeded company; nothing written`);
    const flag = (await client.query<{ id: string }>('SELECT id FROM feature_flags WHERE code = $1', [code])).rows[0];
    if (!flag) throw new Error(`no feature flag ${code}`);
    const before = (await client.query<{ enabled: boolean }>(
      'SELECT enabled FROM company_feature_overrides WHERE company_id = $1 AND feature_id = $2', [companyId, flag.id])).rows[0];
    if (enabled === null) {
      await client.query('DELETE FROM company_feature_overrides WHERE company_id = $1 AND feature_id = $2', [companyId, flag.id]);
    } else {
      await client.query(
        `INSERT INTO company_feature_overrides (company_id, feature_id, enabled, reason, set_by) VALUES ($1, $2, $3, 'golden z19', $4)
         ON CONFLICT (company_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled`, [companyId, flag.id, enabled, adminId]);
    }
    return before ? before.enabled : null;
  } finally {
    await client.end();
  }
}
