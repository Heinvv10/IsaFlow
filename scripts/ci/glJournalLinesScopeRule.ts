/**
 * glJournalLinesScopeRule — detection logic for BL-13: every gl_journal_lines
 * query must scope by company_id.
 *
 * Kept separate from the CLI entrypoint (check-gl-journal-lines-scope.ts) so
 * the rule is unit-testable, the same split used for `text = uuid` in
 * userIdCastRules.ts. The proof this rule actually works lives in
 * tests/unit/ci/glJournalLinesScopeRule.test.ts as mutation counterexamples,
 * not as a read of this file — see CONTRACTS.md's evidence rule.
 *
 * WHY THIS REPLACED A LINE-PROXIMITY CHECK. The original grepped for
 * "FROM/JOIN gl_journal_lines" and then asked whether "company_id" appeared
 * ANYWHERE within 20 lines above or below, in either direction, in the raw
 * source text. That is not "is this query scoped" — it is "does this word
 * appear nearby" — and both readings of that gap are real:
 *   - An unrelated comment or an adjacent query's company_id inside the
 *     20-line window satisfies it with nothing scoping the actual query.
 *   - A legitimate query whose company_id predicate sits 21+ lines from its
 *     FROM clause (a long SELECT list, a long WHERE) fails it with nothing
 *     wrong, and the failure is different on every run because seven
 *     worktrees editing files nearby shifts line numbers under it — the
 *     flaky CI failure that could not be reproduced.
 *
 * WHAT THIS DOES INSTEAD. It reads the SQL tagged-template LITERAL the query
 * actually sits in — `sql\`...\`` or `tx\`...\`` — as its own bounded span,
 * matching userIdCastRules.ts's SQL_BLOCK. "Scoped" now means: within THIS
 * query's own template body, after SQL comments and string literals are
 * stripped out (so a comment or a quoted string cannot satisfy or evade the
 * check — only a real predicate can), a company_id reference exists. A
 * one-line query and a 200-line query are checked identically; distance in
 * the source text no longer matters at all, which is the point.
 *
 * customReportFieldDefs.ts, previously hard-excluded by filename with a
 * comment explaining it is a string-template FROM clause and not an executed
 * query: its `FROM gl_journal_lines` sits inside a plain `` `...` `` template
 * with no `sql`/`tx` tag, so SQL_BLOCK never matches it and it is excluded
 * structurally now — the allowlist entry is gone because the reason for it
 * no longer needs stating by hand.
 */

export interface Violation {
  line: number;
  snippet: string;
}

const SQL_BLOCK = /(?:sql|tx)`([\s\S]*?)`/g;
const GL_JOURNAL_LINES_REF = /\b(?:FROM|JOIN)\s+gl_journal_lines\b/i;
// Any alias's company_id ("jl.company_id"), or a bare, unaliased reference
// used as a predicate ("company_id = " / "company_id::UUID") — the shape a
// query written directly against gl_journal_lines with no alias uses.
const COMPANY_ID_SCOPE = /\b[a-zA-Z_]\w*\.company_id\b|\bcompany_id\s*(?:=|::)/;

/** Strips SQL line comments, block comments, and single-quoted string
 * literals from a query body, so a mention of company_id (or of
 * gl_journal_lines itself) inside commented-out or quoted text cannot be
 * mistaken for a real predicate or a real table reference. Postgres string
 * literals escape an embedded quote by doubling it (`''`), which this keeps
 * intact — it only removes the quotes and content between them. */
function stripCommentsAndStrings(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function findViolations(text: string): Violation[] {
  const out: Violation[] = [];

  for (const m of text.matchAll(SQL_BLOCK)) {
    const rawBody = m[1] ?? '';
    const body = stripCommentsAndStrings(rawBody);

    if (!GL_JOURNAL_LINES_REF.test(body)) continue;
    if (COMPANY_ID_SCOPE.test(body)) continue;

    out.push({
      line: lineOf(text, m.index ?? 0),
      snippet: rawBody.trim().slice(0, 120).replace(/\s+/g, ' '),
    });
  }

  return out;
}
