/**
 * userIdCastRules — detection logic for the `text = uuid` defect class.
 *
 * Kept separate from the CLI entrypoint (`audit-user-id-casts.ts`) so the rules
 * are unit-testable. A 150-line guard whose own regexes are unverified is not a
 * guard; the counterexamples in tests/unit/ci/userIdCastRules.test.ts are the
 * proof that each rule fires and, just as importantly, that it does not fire on
 * legitimate code.
 *
 * Why any of this exists: user identity is a STRING in this schema.
 *   users.id              character varying  (default (gen_random_uuid())::text)
 *   company_users.user_id text
 * Postgres has no `text = uuid` / `character varying = uuid` operator, so a
 * ::UUID cast on a user-identity comparison throws at RUNTIME. The SQL lives in
 * a template string, so neither tsc nor eslint can see it.
 */

/** Tables whose user-identity column is a string type, not uuid. */
export const STRING_ID_TABLES = [
  'company_users',
  'bureau_users',
  'user_sessions',
  'user_permissions',
  'company_user_permissions',
  'user_preferences',
  'audit_log',
  'analytics_sessions',
  'page_visits',
  'password_reset_tokens',
  'mcp_tool_calls',
  'oauth_authorisations',
  'oauth_authorisation_codes',
  'personal_access_tokens',
] as const;

/**
 * Columns on OTHER tables that are string-typed and so may be joined to
 * users.id without a cast. Anything not listed is assumed uuid and therefore
 * requires an explicit ::TEXT.
 */
const STRING_FK_COLUMNS = ['created_by', 'invited_by', 'changed_by', 'admin_user_id'];

export interface Violation {
  line: number;
  rule: string;
  snippet: string;
}

const SQL_BLOCK = /(?:sql|tx)`([\s\S]*?)`/g;
// Note the \s* before ::UUID — `${x} ::UUID` must not slip through.
const PARAM_CAST = String.raw`\$\{[^}]+\}\s*::\s*UUID`;

/** Maps each alias in the block to the table it is bound to. */
function aliasMap(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][\w]*)\s+(?:AS\s+)?([a-z_][\w]*)\b/gi;
  for (const m of body.matchAll(re)) {
    const table = (m[1] ?? '').toLowerCase();
    const alias = (m[2] ?? '').toLowerCase();
    // Skip SQL keywords that can follow a table name (e.g. "FROM users WHERE").
    if (['where', 'on', 'set', 'values', 'select', 'group', 'order', 'limit', 'join', 'left', 'inner', 'and'].includes(alias)) continue;
    map.set(alias, table);
  }
  return map;
}

/** The table a bare (unaliased) column reference belongs to. */
function primaryTable(body: string): string | null {
  const m = /\b(?:FROM|UPDATE|INTO)\s+([a-z_][\w]*)/i.exec(body);
  return m ? (m[1] ?? '').toLowerCase() : null;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function findViolations(text: string): Violation[] {
  const out: Violation[] = [];

  for (const m of text.matchAll(SQL_BLOCK)) {
    const body = m[1] ?? '';
    const line = lineOf(text, m.index ?? 0);
    const aliases = aliasMap(body);
    const primary = primaryTable(body);

    // ── Rule 1: user_id compared to a ::UUID-cast parameter, where that
    // user_id demonstrably belongs to a string-id table. Resolving the alias
    // (rather than checking whether the table name appears anywhere in the
    // block) is what stops an unrelated uuid `t.user_id` being flagged just
    // because company_users is also joined.
    const r1 = new RegExp(String.raw`(?:(\w+)\.)?\buser_id\s*=\s*${PARAM_CAST}`, 'gi');
    for (const hit of body.matchAll(r1)) {
      const alias = (hit[1] ?? '').toLowerCase();
      const table = alias ? aliases.get(alias) : primary;
      if (table && (STRING_ID_TABLES as readonly string[]).includes(table)) {
        out.push({ line, rule: `user_id ::UUID cast against ${table} (string column)`, snippet: hit[0] });
      }
    }

    // ── Rule 2: users.id compared to a ::UUID-cast parameter. Any alias bound
    // to `users` counts, not just the conventional `u`.
    const usersAliases = [...aliases.entries()].filter(([, t]) => t === 'users').map(([a]) => a);
    const r2 = new RegExp(String.raw`(?:(\w+)\.)?\bid\s*=\s*${PARAM_CAST}`, 'gi');
    for (const hit of body.matchAll(r2)) {
      const alias = (hit[1] ?? '').toLowerCase();
      const belongsToUsers = alias ? usersAliases.includes(alias) : primary === 'users';
      if (belongsToUsers) {
        out.push({ line, rule: 'users.id ::UUID cast (users.id is character varying)', snippet: hit[0] });
      }
    }

    // ── Rule 3: a join onto users.id whose other side is not a known string
    // column and is not cast to text. Matches both operand orders.
    for (const alias of usersAliases) {
      const forms = [
        new RegExp(String.raw`\b${alias}\.id\s*=\s*([a-z_][\w]*\.[\w]+)(\s*::\s*(\w+))?`, 'gi'),
        new RegExp(String.raw`([a-z_][\w]*\.[\w]+)(\s*::\s*(\w+))?\s*=\s*\b${alias}\.id\b`, 'gi'),
      ];
      for (const re of forms) {
        for (const hit of body.matchAll(re)) {
          const col = (hit[1] ?? '').toLowerCase();
          const cast = (hit[3] ?? '').toUpperCase();
          if (cast === 'TEXT' || cast === 'VARCHAR') continue;
          const [colAlias, colName] = col.split('.');
          const colTable = aliases.get(colAlias ?? '') ?? '';
          const isStringCol =
            STRING_FK_COLUMNS.includes(colName ?? '') ||
            (colName === 'user_id' && (STRING_ID_TABLES as readonly string[]).includes(colTable));
          if (!isStringCol) {
            out.push({
              line,
              rule: 'users.id join without ::TEXT on a uuid column',
              snippet: (hit[0] ?? '').replace(/\s+/g, ' '),
            });
          }
        }
      }
    }
  }

  return out;
}
