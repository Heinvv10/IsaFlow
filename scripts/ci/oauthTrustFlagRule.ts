/**
 * oauthTrustFlagRule — detection logic for: nothing may undo migration 693's
 * guard on `oauth_apps.is_verified` / `is_first_party`.
 *
 * Kept separate from the CLI entrypoint (check-oauth-trust-flags.ts) so the
 * rule is unit-testable, the same split used by migrationRlsRule.ts and
 * glJournalLinesScopeRule.ts. The proof this rule works is
 * tests/unit/ci/oauthTrustFlagRule.test.ts as mutation counterexamples — not
 * a read of this file.
 *
 * WHY THIS EXISTS. Those two columns decide whether an OAuth app may put its
 * own logo, description and homepage link on the consent and revoke screens
 * and wear a "Verified" badge. Migration 693 makes them unwritable by the
 * application. The only guard proving that is
 * tests/integration/oauth-apps-trust-flags.int.test.ts, and `bun run ci` skips
 * the whole integration step when DATABASE_URL is unset — so a change that
 * undid 693 would leave CI green. That is precisely the failure shape
 * check-migration-rls.ts exists for: a guard that can silently not run.
 *
 * WHAT 693 ACTUALLY RELIES ON, because the gate has to defend the right half:
 * column privileges are never consulted for a table's OWNER, the pool connects
 * as `postgres`, and `postgres` owns oauth_apps — so the column grants bind
 * only the routes that issue `SET LOCAL ROLE app_user`, and the PUBLIC
 * unauthenticated DCR endpoint is not one of them. The TRIGGERS are what bind
 * the anonymous path. A gate that watched the grants and ignored the triggers
 * would guard the weaker half only, which is why trigger regressions are in
 * scope here.
 *
 * SCOPE, ON PURPOSE. Text-only, no database connection, so it runs on every
 * `bun run ci`. It cannot see what the live database actually holds — a DBA
 * running `GRANT` by hand is invisible to it, and always will be. It catches
 * the regression that arrives as a COMMITTED FILE, which is the one code
 * review and CI are able to catch at all.
 */

/** The deliberate escape hatch 693 honours. Must never appear in app code. */
export const TRUST_FLAG_GUC = 'isaflow.allow_trust_flag_write';

/** Migrations at or below this number are 693 and its predecessors. */
const GUARD_MIGRATION = 693;

const GUARD_TRIGGER_PREFIX = 'oauth_apps_guard_trust_flags';
const GUARDED_TABLE = 'oauth_apps';
const APP_ROLE = 'app_user';

export interface Violation {
  file: string;
  line: number;
  reason: string;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * Strip `--` line comments and `/* *\/` block comments.
 *
 * Without this, a migration whose comment WARNS about the hazard —
 * "do not GRANT UPDATE ON oauth_apps TO app_user" — fails the build for
 * saying the right thing. Replaces with spaces rather than deleting so every
 * surviving index still maps to its original line number.
 */
function stripSqlComments(text: string): string {
  return text
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** The 3-digit prefix of a migration filename, or null when it has none. */
export function migrationNumber(file: string): number | null {
  const base = file.split('/').pop() ?? file;
  const m = /^(\d{3})[_a-z0-9]*\.sql$/i.exec(base);
  if (!m?.[1]) return null;
  // Base 10 explicitly: a leading zero must not be read as octal.
  return parseInt(m[1], 10);
}

/**
 * Application code that sets the escape-hatch GUC.
 *
 * The hatch is for a human at a psql prompt. `app_user` can set it, so it
 * stops accidents rather than a caller who already has SQL execution — but a
 * REQUEST path that sets it would make the guard void for every call through
 * that path, which is a different and much worse thing.
 */
export function findHatchUsages(files: Array<{ file: string; text: string }>): Violation[] {
  const out: Violation[] = [];
  for (const { file, text } of files) {
    let idx = text.indexOf(TRUST_FLAG_GUC);
    while (idx !== -1) {
      out.push({
        file,
        line: lineOf(text, idx),
        reason: `sets or names the trust-flag escape hatch (${TRUST_FLAG_GUC}); it exists for a human at a psql prompt, not for application code`,
      });
      idx = text.indexOf(TRUST_FLAG_GUC, idx + 1);
    }
  }
  return out;
}

/**
 * Migrations AFTER 693 that undo any part of it.
 *
 * Four shapes, each reproduced as a counterexample in the test file:
 *  - `GRANT ... ON oauth_apps TO app_user` with NO column list — restores the
 *    table-level privilege 693 revoked.
 *  - `GRANT ... ON ALL TABLES IN SCHEMA public TO app_user` — migration 348's
 *    statement; re-running it restores the same privilege on every table.
 *  - dropping or disabling a guard trigger.
 *  - `ENABLE TRIGGER` without ALWAYS — silently downgrades out of ALWAYS mode
 *    and reopens the session_replication_role bypass, with no other symptom.
 *
 * `ALTER DEFAULT PRIVILEGES` is deliberately NOT a violation: it applies to
 * tables created later, never to an existing one, so it cannot reopen this.
 */
export function findGuardRegressions(files: Array<{ file: string; text: string }>): Violation[] {
  const out: Violation[] = [];

  for (const { file, text: raw } of files) {
    const n = migrationNumber(file);
    if (n === null || n <= GUARD_MIGRATION) continue;
    const text = stripSqlComments(raw);

    // GRANT ... ON oauth_apps TO app_user, with no column list between the
    // privilege list and ON. A column list is the safe, intended form.
    const tableGrant = new RegExp(
      String.raw`\bGRANT\s+(?![^;]*\()[\w\s,]*?\bON\s+(?:TABLE\s+)?${GUARDED_TABLE}\b[^;]*?\bTO\s+[^;]*\b${APP_ROLE}\b`,
      'gis',
    );
    for (const m of text.matchAll(tableGrant)) {
      out.push({
        file,
        line: lineOf(text, m.index),
        reason: `re-grants a table-level privilege on ${GUARDED_TABLE} to ${APP_ROLE}, undoing migration 693's REVOKE (use a column list)`,
      });
    }

    const allTables = new RegExp(
      String.raw`\bGRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+\w+\s+TO\s+[^;]*\b${APP_ROLE}\b`,
      'gis',
    );
    for (const m of text.matchAll(allTables)) {
      out.push({
        file,
        line: lineOf(text, m.index),
        reason: `GRANT ON ALL TABLES to ${APP_ROLE} restores the table-level privilege on ${GUARDED_TABLE} that migration 693 revoked`,
      });
    }

    const dropOrDisable = new RegExp(
      String.raw`\b(?:DROP\s+TRIGGER(?:\s+IF\s+EXISTS)?\s+${GUARD_TRIGGER_PREFIX}\w*|DISABLE\s+TRIGGER\s+${GUARD_TRIGGER_PREFIX}\w*)`,
      'gis',
    );
    for (const m of text.matchAll(dropOrDisable)) {
      out.push({
        file,
        line: lineOf(text, m.index),
        reason: `drops or disables a trust-flag guard trigger; the triggers are what bind the anonymous DCR path, which writes as the table owner and is not bound by column privileges`,
      });
    }

    // ENABLE TRIGGER <guard> that is not ENABLE ALWAYS TRIGGER.
    const enableNotAlways = new RegExp(
      String.raw`\bENABLE\s+(?!ALWAYS\b)(?:REPLICA\s+)?TRIGGER\s+${GUARD_TRIGGER_PREFIX}\w*`,
      'gis',
    );
    for (const m of text.matchAll(enableNotAlways)) {
      out.push({
        file,
        line: lineOf(text, m.index),
        reason: `ENABLE TRIGGER without ALWAYS downgrades the guard out of ALWAYS mode, reopening the session_replication_role bypass (use ENABLE ALWAYS TRIGGER)`,
      });
    }
  }

  return out;
}
