/**
 * migrationRlsRule — detection logic for: every table created with a
 * `company_id` column must end up under row-level security.
 *
 * Kept separate from the CLI entrypoint (check-migration-rls.ts) so the rule
 * is unit-testable, the same split used for `text = uuid`
 * (userIdCastRules.ts) and BL-13 (glJournalLinesScopeRule.ts). The proof this
 * rule works is tests/unit/ci/migrationRlsRule.test.ts as mutation
 * counterexamples, per CONTRACTS.md's evidence rule — not a read of this file.
 *
 * WHY THIS EXISTS. `595_gl_account_merges.sql` created `gl_account_merges`
 * with a `company_id` column and no RLS anywhere — no ENABLE, no FORCE, no
 * policy. It is (was, at time of writing) the only table in the schema with
 * that gap. The guard that WOULD have caught it,
 * `tests/integration/rls-policy-coverage.test.ts`, lives in the integration
 * suite, which `bun run ci` gates on `DATABASE_URL` plus five other env vars
 * and silently SKIPS without them — so it never ran, and CI stayed green. A
 * guard that can silently not run is the same defect class as a guard that
 * cannot fail. This is a text-only, no-connection gate so it runs every time.
 *
 * SCOPE, ON PURPOSE. Only `CREATE TABLE` statements whose column list
 * contains a literal `company_id UUID` column — the shape CLAUDE.md's
 * "every table needs company_id UUID REFERENCES companies(id)" rule
 * describes. A table that gets `company_id` bolted on later via
 * `ALTER TABLE ... ADD COLUMN` is a different, narrower case (the table
 * already existed and its own RLS history, if any, predates the column) and
 * is not what this gate is for.
 *
 * WHOLE-DIRECTORY, NOT SAME-FILE — the deliberate call. RLS legitimately
 * arrives in a LATER migration in this repo already, as established
 * practice predating this gate: `467_personal_access_tokens.sql` creates the
 * table, `468_personal_access_tokens_rls.sql` protects it two migrations
 * later; `253_missing_tables.sql` creates `bank_import_batches`,
 * `442_bank_import_batches.sql` protects it nearly 200 migrations later.
 * `596_gl_account_merges_rls.sql` — the sibling workstream's fix for the
 * exact table this gate exists because of — follows the same, already
 * established pattern. A same-file requirement would fail permanently on
 * every one of those already-correctly-protected historical pairs the day
 * this gate is switched on, which is a worse outcome than the gap it closes:
 * a gate that fails on correctly-remediated code trains people to disable
 * it. Whole-directory catches the actual defect this gate exists for (a
 * table with NO protecting migration anywhere, same file or not) without
 * manufacturing false alarms on the repo's normal create-then-protect
 * rhythm.
 *
 * A THIRD SHAPE THIS DOES RECOGNIZE. `505_close_runs.sql` grants RLS with
 * `FOREACH t IN ARRAY ARRAY['close_runs', 'close_run_proposals'] LOOP ...
 * EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t)`.
 * The table name never sits next to the SQL keywords as text (it is `%I`,
 * substituted at runtime), but it IS literal text inside the `ARRAY[...]`
 * — `dynamicArrayProtectedTables` below reads it out of there and treats a
 * table listed in such an array, in a file that also contains the three RLS
 * incantations as literal text, as protected.
 *
 * WHAT THIS DOES NOT AND CANNOT CATCH. Migrations 348 and 498 grant RLS to
 * tables DYNAMICALLY — a `DO $$ ... FOR r IN (SELECT ... FROM pg_policies
 * ...)` loop that DISCOVERS non-compliant `company_id` tables by querying
 * the catalogue AT APPLY TIME and protects whichever ones existed then. No
 * table name appears as literal text ANYWHERE in either migration — unlike
 * 505's array, there is nothing to read a name out of — so this gate cannot
 * see that protection and will flag every table created before 498 that has
 * no individual protection of its own (same-file, later-file, or the
 * 505-style array). That is a real, expected, and large class of findings
 * from this gate's point of view, even though those tables ARE protected in
 * the actual database. This is why "PASSES on the current tree" is not a
 * claim this rule can make on its own; see check-migration-rls.ts's own
 * comment and the CI report for what running it against the live migrations
 * directory actually finds.
 */

export interface CreateTable {
  table: string;
  file: string;
  line: number;
  hasCompanyId: boolean;
}

export interface Violation {
  table: string;
  file: string;
  line: number;
}

const CREATE_TABLE_RE = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-zA-Z_][\w.]*)\s*\(/gi;
const COMPANY_ID_COLUMN = /\bcompany_id\s+UUID\b/i;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Finds the index of the `)` that closes the `(` at openIndex, skipping
 * single-quoted string literals (with `''` escapes) and `--` line comments
 * so a stray paren inside either cannot desync the count. */
function matchParen(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Every `CREATE TABLE` statement in one file's text, with whether its own
 * column list declares `company_id UUID`. */
export function findCreateTables(file: string, text: string): CreateTable[] {
  const out: CreateTable[] = [];
  for (const m of text.matchAll(CREATE_TABLE_RE)) {
    const openIndex = (m.index ?? 0) + m[0].length - 1;
    const closeIndex = matchParen(text, openIndex);
    if (closeIndex === -1) continue; // malformed SQL — not this rule's job
    const body = text.slice(openIndex + 1, closeIndex);
    const rawName = (m[1] ?? '').toLowerCase();
    const table = rawName.startsWith('public.') ? rawName.slice('public.'.length) : rawName;
    out.push({
      table,
      file,
      line: lineOf(text, m.index ?? 0),
      hasCompanyId: COMPANY_ID_COLUMN.test(body),
    });
  }
  return out;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DYNAMIC_ARRAY_LOOP = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/gi;
const QUOTED_IDENT = /'([a-zA-Z_][\w]*)'/g;

/** Tables named literally inside a `FOREACH t IN ARRAY ARRAY['a', 'b'] LOOP`
 * block (505_close_runs.sql's shape) whose file ALSO contains the three RLS
 * incantations as literal text — `EXECUTE format('ALTER TABLE ... %I ENABLE
 * ROW LEVEL SECURITY', t)` never spells the table name next to the SQL
 * keywords, so the plain same-file regex below cannot see it, even though
 * the table name IS literal text right there in the array. Distinct from
 * 348/498's blind spot: those discover tables via a `SELECT ... FROM
 * pg_policies` query at apply time and never name a table as text anywhere
 * in the file, so there is nothing for even this broader check to find. */
function dynamicArrayProtectedTables(files: Array<{ text: string }>): Set<string> {
  const out = new Set<string>();
  for (const { text } of files) {
    const hasAllThreeGrants =
      /ENABLE ROW LEVEL SECURITY/i.test(text) &&
      /FORCE ROW LEVEL SECURITY/i.test(text) &&
      /CREATE POLICY/i.test(text);
    if (!hasAllThreeGrants) continue;
    for (const loop of text.matchAll(DYNAMIC_ARRAY_LOOP)) {
      const arrayBody = loop[1] ?? '';
      for (const id of arrayBody.matchAll(QUOTED_IDENT)) {
        if (id[1]) out.add(id[1].toLowerCase());
      }
    }
  }
  return out;
}

/** Whether `table` has ENABLE, FORCE, and at least one CREATE POLICY
 * somewhere in the combined text of every migration file — same file or
 * not; see the whole-directory rationale above. Also accepts the dynamic
 * per-table EXECUTE-format loop shape (see dynamicArrayProtectedTables). */
function isProtected(table: string, corpus: string, dynamicallyProtected: Set<string>): boolean {
  if (dynamicallyProtected.has(table)) return true;
  const t = escapeForRegex(table);
  const enableRe = new RegExp(String.raw`ALTER TABLE\s+(?:public\.)?${t}\s+ENABLE ROW LEVEL SECURITY`, 'i');
  const forceRe = new RegExp(String.raw`ALTER TABLE\s+(?:public\.)?${t}\s+FORCE ROW LEVEL SECURITY`, 'i');
  const policyRe = new RegExp(String.raw`CREATE POLICY\s+\S+\s+ON\s+(?:public\.)?${t}\b`, 'i');
  return enableRe.test(corpus) && forceRe.test(corpus) && policyRe.test(corpus);
}

/** files: ordered {file, text} pairs — typically every scripts/migrations/sql/*.sql
 * file, in any order (order does not affect the result; RLS may arrive in an
 * earlier-numbered OR later-numbered file relative to the CREATE TABLE, and
 * both are treated identically). */
export function findViolations(files: Array<{ file: string; text: string }>): Violation[] {
  const corpus = files.map(f => f.text).join('\n');
  const dynamicallyProtected = dynamicArrayProtectedTables(files);
  const out: Violation[] = [];
  const seen = new Set<string>(); // one violation per table, first CREATE TABLE site

  for (const { file, text } of files) {
    for (const ct of findCreateTables(file, text)) {
      if (!ct.hasCompanyId) continue;
      if (seen.has(ct.table)) continue;
      if (isProtected(ct.table, corpus, dynamicallyProtected)) continue;
      seen.add(ct.table);
      out.push({ table: ct.table, file: ct.file, line: ct.line });
    }
  }
  return out;
}
