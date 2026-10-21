/**
 * Dynamic (RFC 7591) OAuth client housekeeping.
 *
 * Unauthenticated registration creates oauth_apps rows; without cleanup the
 * table grows without bound from anonymous input. pruneStaleDynamicApps
 * deletes dynamic clients that are older than STALE_DAYS and were never
 * authorised by any user — called opportunistically (fire-and-forget) from
 * the register route, so no cron dependency.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

const STALE_DAYS = 30;

/**
 * True when `appId` is a dynamically registered (RFC 7591) client: what a
 * marketplace connector such as Grok Bot or Cursor registers as. Used by MCP
 * Flow metering (FB-6), which does not bill calls made through one.
 *
 * Runs as whatever the caller's `sql` context is; under the MCP request's
 * app_user transaction, RLS policy `oauth_apps_dynamic_read` (migration 506)
 * exposes exactly the non-revoked dynamic rows. A row it does not expose, a
 * pre-registered app included, answers false, so the default stays "metered".
 */
export async function isDynamicOauthApp(appId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM oauth_apps
    WHERE id = ${appId}::uuid AND is_dynamic AND revoked_at IS NULL
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

/** Delete never-authorised dynamic clients older than 30 days. Returns count. */
export async function pruneStaleDynamicApps(): Promise<number> {
  const rows = (await sql`
    DELETE FROM oauth_apps a
    WHERE a.is_dynamic
      AND a.created_at < NOW() - (${STALE_DAYS} || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM oauth_authorisations auth WHERE auth.oauth_app_id = a.id
      )
    RETURNING a.id
  `) as Row[];

  if (rows.length > 0) {
    log.info('DCR: pruned stale dynamic clients', { count: rows.length }, 'oauth');
  }
  return rows.length;
}
