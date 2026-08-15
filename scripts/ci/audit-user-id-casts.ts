/**
 * audit-user-id-casts — CI guard for the `text = uuid` defect class.
 *
 * User identity is a STRING in this schema, not a uuid:
 *   users.id              character varying  (default (gen_random_uuid())::text)
 *   company_users.user_id text
 *
 * Postgres has no `text = uuid` or `character varying = uuid` operator, so a
 * `::UUID` cast on either side of a user-identity comparison throws at RUNTIME
 * (a 500), never at compile time — the SQL is a template string, so neither
 * tsc nor eslint can see it. Eighteen such sites shipped to production and
 * silently killed the group-access guards, company user management, the
 * permission-grant guard, POPIA export AND erasure, credit-note PDFs, approval
 * listings and practice reports.
 *
 * This guard fails the build on two patterns:
 *   1. `company_users.user_id = ${param}::UUID`  (and the bare `user_id` form
 *      inside a block that targets company_users)
 *   2. `users.id = ${param}::UUID`
 *   3. a `users` join whose other side is cast to nothing but is a uuid column
 *      — covered structurally by requiring an explicit ::TEXT on the far side
 *      of any `u.id = <table>.<col>` join.
 *
 * Run: bun scripts/ci/audit-user-id-casts.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['pages', 'src'];
const SQL_BLOCK = /(?:sql|tx)`([\s\S]*?)`/g;

/** Tables whose user-identity column is a string type, not uuid. */
const STRING_ID_TABLES = [
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
];

interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(p, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

const violations: Violation[] = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('::UUID') && !text.includes('users')) continue;

    for (const m of text.matchAll(SQL_BLOCK)) {
      const body = m[1] ?? '';
      const startLine = lineOf(text, m.index ?? 0);

      // Rule 1 — user_id compared to a ::UUID-cast parameter, in a block that
      // targets a table whose user-identity column is a string.
      const userIdCast = /\b(?:\w+\.)?user_id\s*=\s*\$\{[^}]+\}::UUID/.exec(body);
      if (userIdCast) {
        const tbl = STRING_ID_TABLES.find(t => new RegExp(`\\b${t}\\b`).test(body));
        if (tbl) {
          violations.push({
            file, line: startLine, rule: `user_id ::UUID cast against ${tbl} (string column)`,
            snippet: userIdCast[0],
          });
        }
      }

      // Rule 2 — users.id compared to a ::UUID-cast parameter.
      if (/\b(?:FROM|JOIN|UPDATE|INTO)\s+users\b/i.test(body)) {
        const idCast = /\b(?:u\.)?id\s*=\s*\$\{[^}]+\}::UUID/.exec(body);
        // Only flag when `users` is the table the predicate belongs to: a block
        // whose only `id = ${..}::UUID` sits on an aliased other table is fine.
        if (idCast && !/\b(?!u\.)\w+\.id\s*=\s*\$\{[^}]+\}::UUID/.test(body)) {
          violations.push({
            file, line: startLine, rule: 'users.id ::UUID cast (users.id is character varying)',
            snippet: idCast[0],
          });
        }
      }

      // Rule 3 — a join onto users.id from a column that is NOT cast to text.
      // users.id is varchar; any uuid column must be cast explicitly.
      for (const j of body.matchAll(/JOIN\s+users\s+(\w+)\s+ON\s+\1\.id\s*=\s*([A-Za-z_][\w.]*)(::\w+)?/gi)) {
        const cast = j[3];
        if (!cast || cast.toUpperCase() !== '::TEXT') {
          // company_users.user_id and other string columns need no cast.
          const rhs = (j[2] ?? '').toLowerCase();
          const rhsIsKnownString = STRING_ID_TABLES.some(t => body.toLowerCase().includes(t))
            && /\.user_id$/.test(rhs);
          const rhsIsVarcharCol = /created_by|invited_by|changed_by|admin_user_id/.test(rhs);
          if (!rhsIsKnownString && !rhsIsVarcharCol) {
            violations.push({
              file, line: startLine,
              rule: 'users.id join without ::TEXT on a uuid column',
              snippet: (j[0] ?? '').replace(/\s+/g, ' '),
            });
          }
        }
      }
    }
  }
}

console.log('=== user-identity is a string: no ::UUID casts on user_id / users.id ===');
if (violations.length > 0) {
  console.error(
    `ERROR: ${violations.length} user-identity type violation(s). ` +
    'Postgres has no text = uuid operator — these throw at runtime, not compile time.'
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n      ${v.rule}\n      ${v.snippet}`);
  }
  process.exit(1);
}
console.log('OK: no ::UUID casts against string user-identity columns.');
