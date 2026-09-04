/**
 * Mutation counterexamples for glJournalLinesScopeRule — the proof the rule
 * fires on what it must catch, and stays quiet on what it must not, per
 * CONTRACTS.md's evidence rule: reading the regex is not evidence, a red
 * test on the broken shape is.
 *
 * The predecessor of this rule (a ±20-line proximity `awk` check) could be
 * satisfied by a `company_id` mention anywhere nearby in the source text,
 * including inside an unrelated comment — see the `leak()` case below, taken
 * verbatim from the report that found the hole.
 */
import { describe, it, expect } from 'vitest';
import { findViolations } from '../../../scripts/ci/glJournalLinesScopeRule';

describe('glJournalLinesScopeRule', () => {
  it('FAILS the reported leak() — a comment outside the query cannot satisfy scoping', () => {
    const src = `
// A comment mentioning company_id = \${companyId} to explain scoping elsewhere.
export async function leak() {
  return await sql\`
    SELECT SUM(debit) FROM gl_journal_lines
  \`;
}
`;
    const v = findViolations(src);
    expect(v).toHaveLength(1);
    expect(v[0]!.snippet).toContain('gl_journal_lines');
  });

  it('FAILS an unscoped query even with a legitimate company_id on an adjacent query 5 lines away', () => {
    // The false-negative that matters most in real code: a scoped query sits
    // right next to an unscoped one. Proximity would forgive the second
    // query for the first one's predicate; this rule must not.
    const src = `
async function loadTwoThings(companyId: string) {
  const accounts = await sql\`
    SELECT id FROM gl_accounts WHERE company_id = \${companyId}::uuid
  \`;
  const lines = await sql\`
    SELECT debit, credit FROM gl_journal_lines
  \`;
  return { accounts, lines };
}
`;
    const v = findViolations(src);
    expect(v).toHaveLength(1);
  });

  it('PASSES a correctly-scoped query whose company_id sits 25+ lines from the FROM clause', () => {
    // The false-positive that caused the flaky CI failure: a long SELECT
    // list pushes the predicate well past any fixed line window. Distance
    // inside the SAME template body must not matter at all.
    const filler = Array.from({ length: 25 }, (_, i) => `           col${i},`).join('\n');
    const src = `
async function longSelect(companyId: string) {
  return await sql\`
    SELECT
${filler}
           jl.debit
    FROM gl_journal_lines jl
    WHERE jl.company_id = \${companyId}::uuid
  \`;
}
`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('a SQL line comment inside the query cannot satisfy scoping', () => {
    const src = `
await sql\`
  SELECT debit FROM gl_journal_lines jl
  -- jl.company_id would go here once we scope this
\`;
`;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('a SQL block comment inside the query cannot satisfy scoping', () => {
    const src = `
await sql\`
  SELECT debit FROM gl_journal_lines jl
  /* TODO: AND jl.company_id = $1 */
\`;
`;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('a string literal inside the query cannot satisfy scoping', () => {
    const src = `
await sql\`
  SELECT debit, 'scoped by company_id upstream' AS note
  FROM gl_journal_lines jl
\`;
`;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('PASSES a bare unaliased company_id predicate', () => {
    const src = `
await sql\`
  SELECT debit FROM gl_journal_lines
  WHERE company_id = \${companyId}::uuid
\`;
`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('PASSES any alias dotted with company_id, not just jl/je/gjl', () => {
    const src = `
await sql\`
  SELECT x.debit FROM gl_journal_lines x
  WHERE x.company_id = \${companyId}::uuid
\`;
`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('ignores an untagged template literal (no sql/tx tag) entirely', () => {
    // customReportFieldDefs.ts's FROM/JOIN clause is plain string assembly,
    // not an executed query — SQL_BLOCK only matches sql`...` / tx`...`.
    const src = `
export function getBaseQuery() {
  return \`FROM gl_journal_entries je
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id\`;
}
`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('ignores a query that never mentions gl_journal_lines', () => {
    const src = `
await sql\`SELECT 1 FROM gl_accounts\`;
`;
    expect(findViolations(src)).toHaveLength(0);
  });
});
