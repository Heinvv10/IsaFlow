/**
 * Revoke the GoTrue sessions of every user who was impersonated BEFORE the
 * impersonation route began recording the minted session id.
 *
 *   bun scripts/revoke-legacy-impersonation-sessions.ts            # dry run, counts only
 *   bun scripts/revoke-legacy-impersonation-sessions.ts --apply    # revokes
 *
 * WHY THIS IS A DEPLOY STEP, not a nicety. A control decision refuses an
 * impersonated session by two signals: the delegation-proof cookie (droppable,
 * and at most an hour old) and the impersonation_start audit row's
 * `target_session_id`. Rows written before that change carry no session id, and
 * ending impersonation never revoked the target's GoTrue session, so any
 * retained refresh token from one of those impersonations still mints access
 * tokens that BOTH signals miss. Nothing in the session distinguishes it from
 * the member's own — see the evidence document — so revocation is the remedy.
 *
 * This revokes every session of the affected members, including their own: they
 * are signed out and log in again. Run it once, at the deploy that ships the
 * recorded session id. It is idempotent and safe to re-run.
 *
 * Requires DATABASE_URL plus the GoTrue environment (GOTRUE_URL, JWT_SECRET,
 * SUPABASE_ANON_KEY). Never run against a database you did not intend: the dry
 * run prints the exact targets first.
 */
import pg from 'pg';

export const legacyImpersonationTargetsSql = `
  SELECT DISTINCT l.target_id::text AS target_id, u.email
  FROM admin_audit_log l
  LEFT JOIN users u ON u.id = l.target_id::text
  WHERE l.action='impersonation_start' AND l.target_type='user'
    AND l.details->>'target_session_id' IS NULL
  ORDER BY 1`;

export interface LegacyTargetRow { target_id: string; email: string | null }
export interface RevocationDeps {
  query: (sql: string) => Promise<LegacyTargetRow[]>;
  revoke: (userId: string, email?: string) => Promise<void>;
  log: (message: string) => void;
  apply: boolean;
}

/** Counts always; revokes only when applied, and never reports a failed revocation as done. */
export async function revokeLegacyImpersonationSessions(deps: RevocationDeps):
  Promise<{ targets: number; revoked: number; failed: number }> {
  const rows = await deps.query(legacyImpersonationTargetsSql);
  deps.log(`impersonation targets without a recorded session id: ${rows.length}`);
  for (const row of rows) deps.log(`  ${row.target_id}${row.email ? ` <${row.email}>` : ''}`);
  if (!deps.apply) {
    deps.log('dry run — no session was revoked. Re-run with --apply to revoke.');
    return { targets: rows.length, revoked: 0, failed: 0 };
  }
  let revoked = 0, failed = 0;
  for (const row of rows) {
    try {
      await deps.revoke(row.target_id, row.email ?? undefined);
      revoked += 1;
    } catch (error) {
      failed += 1;
      deps.log(`  FAILED ${row.target_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  deps.log(`revoked ${revoked} of ${rows.length}; ${failed} failed`);
  return { targets: rows.length, revoked, failed };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  const { adminRevokeAllUserSessions } = await import('../src/lib/auth/gotrue');
  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    const result = await revokeLegacyImpersonationSessions({
      query: async (sql) => (await pool.query<LegacyTargetRow>(sql)).rows,
      revoke: (userId, email) => adminRevokeAllUserSessions(userId, email),
      log: (message) => process.stdout.write(`${message}\n`),
      apply,
    });
    if (result.failed) process.exitCode = 1;
  } finally { await pool.end(); }
}

if (process.argv[1]?.includes('revoke-legacy-impersonation-sessions')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
