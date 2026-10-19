/**
 * The guard's rule (tests/helpers/ledgerStatements.ts) run over PLANTED evasions: each cheap way of keeping an
 * unmarked ledger figure past tests/unit/guards/yearEndJournalCensus.test.ts must be flagged here.
 */
import { describe, expect, it } from 'vitest';
import { templateLiterals } from '../../helpers/templateLiterals';
import { correlatedToMarkedEntry, headersOnly, REF, selectScopes, ungatedEntryLeftJoins, unmarkedFigureStatements } from '../../helpers/ledgerStatements';

describe('the rule catches planted evasions', () => {
  const MARK = 'AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}';
  const stmt = (body: string, tail = '') =>
    `import { YEAR_END_JOURNAL_SOURCE } from './x';\n// ${MARK}\nexport const q = (c: string) => sql\`${body} ${tail}\`;\n`;
  const FROM = 'FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE je.company_id = ${c}';
  const flagged = (src: string) => unmarkedFigureStatements('planted.ts', src).length;

  it('a marked statement passes and the same statement without the marker is flagged', () => {
    expect(flagged(stmt(`SELECT SUM(jl.debit) AS d ${FROM}`, MARK))).toBe(0);
    expect(flagged(stmt(`SELECT SUM(jl.debit) AS d ${FROM}`))).toBe(1);
  });

  it('SUM with a space, lower case and other aggregates are still figures', () => {
    expect(flagged(stmt(`SELECT SUM (jl.debit) AS d ${FROM}`))).toBe(1);
    expect(flagged(stmt(`select sum(jl.credit) as c ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT MAX (je.entry_date) AS d ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT array_agg(jl.debit) AS d ${FROM}`))).toBe(1);
  });

  it('listing line amounts for a TS-side reduce is a figure, wildcard included', () => {
    expect(flagged(stmt(`SELECT jl.debit, jl.credit ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT jl.* ${FROM}`))).toBe(1);
  });

  it('the marker in an import, a TS comment or a SQL comment does not vouch for the statement', () => {
    const inSqlComment = stmt(`SELECT SUM(jl.debit) AS d -- ${MARK}\n ${FROM}`);
    const inBlockComment = stmt(`SELECT SUM(jl.debit) AS d /* ${MARK} */ ${FROM}`);
    expect(flagged(inSqlComment)).toBe(1);
    expect(flagged(inBlockComment)).toBe(1);
  });

  it('a marked sibling statement does not vouch for an unmarked one in the same file', () => {
    const src = stmt(`SELECT SUM(jl.debit) AS d ${FROM}`, MARK) + stmt(`SELECT SUM(jl.credit) AS c ${FROM}`);
    expect(flagged(src)).toBe(1);
  });

  const SUMQ = (where: string, from = FROM) => stmt(`SELECT SUM(jl.debit) AS d ${from} ${where}`);
  const M = 'je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}';

  it('a neutralised marker does not count: OR TRUE, an OR before it, or a bracket group an OR can switch off', () => {
    expect(flagged(SUMQ(`AND ${M}`))).toBe(0);
    expect(flagged(SUMQ(`AND (${M} OR TRUE)`))).toBe(1);
    expect(flagged(SUMQ(`AND ${M} OR TRUE`))).toBe(1);
    expect(flagged(SUMQ(`AND (je.status = 'draft' OR ${M})`))).toBe(1);
    expect(flagged(SUMQ(`AND (${M} AND je.status = 'posted' OR jl.debit > 0)`))).toBe(1);
    expect(flagged(SUMQ(`AND (je.status = 'posted' OR je.status = 'draft') AND ${M}`))).toBe(0);
  });

  it('a marker inside an SQL string literal does not count', () => {
    expect(flagged(SUMQ(`AND jl.description = '${M}'`))).toBe(1);
  });

  it('a marker on an alias that is not gl_journal_entries in that statement does not count', () => {
    expect(flagged(SUMQ('AND x.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}'))).toBe(1);
    expect(flagged(SUMQ('AND jl.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}'))).toBe(1);
    const aliased = 'FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id WHERE e.company_id = ${c}';
    expect(flagged(SUMQ('AND e.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}', aliased))).toBe(0);
    expect(flagged(SUMQ('AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}', aliased))).toBe(1);
  });

  it('schema-qualified, quoted and comma-joined tables are still ledger statements', () => {
    const where = 'WHERE je.company_id = ${c}';
    expect(flagged(stmt(`SELECT SUM(jl.debit) FROM public.gl_journal_lines jl JOIN public.gl_journal_entries je ON je.id = jl.journal_entry_id ${where}`))).toBe(1);
    expect(flagged(stmt(`SELECT SUM(jl.debit) FROM "gl_journal_lines" jl JOIN "gl_journal_entries" je ON je.id = jl.journal_entry_id ${where}`))).toBe(1);
    expect(flagged(stmt(`SELECT SUM(jl.debit) FROM gl_accounts ga, gl_journal_lines jl, gl_journal_entries je WHERE je.id = jl.journal_entry_id`))).toBe(1);
    expect(flagged(stmt(`SELECT SUM(jl.debit) FROM public.gl_journal_lines jl JOIN public.gl_journal_entries je ON je.id = jl.journal_entry_id ${where} AND ${M}`))).toBe(0);
  });

  it('serialising a line, or its other money column, is a figure', () => {
    expect(flagged(stmt(`SELECT to_jsonb(jl) AS row ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT row_to_json(jl) AS row ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT jl.late_claim_base ${FROM}`))).toBe(1);
    expect(flagged(stmt(`SELECT jl.id, jl.description ${FROM}`))).toBe(0);
  });

  it('a wildcard counts only for an alias bound to gl_journal_lines', () => {
    expect(flagged(stmt(`SELECT x.* FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id JOIN other x ON x.id = jl.id`))).toBe(0);
    expect(flagged(stmt(`SELECT l.* FROM gl_journal_lines l JOIN gl_journal_entries je ON je.id = l.journal_entry_id`))).toBe(1);
  });

  it('the scanner is not thrown by a regex literal holding a quote or a backtick', () => {
    const src = "const clean = (s: string) => s.replace(/'/g, \"''\").replace(/`/g, '');\n"
      + stmt(`SELECT SUM(jl.debit) AS d ${FROM}`);
    expect(flagged(src)).toBe(1);
  });

  it('a nested statement is judged on its own, not by the statement that wraps it', () => {
    const src = 'export const q = (c: string, x: boolean) => sql`SELECT 1 ${x ? sql`SELECT SUM(jl.debit) AS d '
      + `${FROM}\` : sql\`SELECT 2\`} ${MARK}\`;\n`;
    expect(templateLiterals(src).length).toBe(3);
    expect(flagged(src)).toBe(1);
  });

  const BRANCH = (marked: boolean) => `SELECT jl.debit FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE je.company_id = \${c}${marked ? ` AND ${M}` : ''}`;

  it('every SELECT of a UNION needs its own marker: one marked branch does not vouch for the other', () => {
    expect(flagged(stmt(`${BRANCH(true)} UNION ALL ${BRANCH(true)}`))).toBe(0);
    expect(flagged(stmt(`${BRANCH(true)} UNION ALL ${BRANCH(false)}`))).toBe(1);
    expect(flagged(stmt(`${BRANCH(false)} UNION ${BRANCH(true)}`))).toBe(1);
    expect(flagged(stmt(`${BRANCH(true)} EXCEPT ${BRANCH(false)}`))).toBe(1);
  });

  it('every CTE / derived table that reads the tables needs its own marker', () => {
    const cte = (a: boolean, b: boolean) => `WITH a AS (${BRANCH(a)}), b AS (${BRANCH(b)}) SELECT * FROM a, b`;
    expect(flagged(stmt(cte(true, true)))).toBe(0);
    expect(flagged(stmt(cte(true, false)))).toBe(1);
    expect(flagged(stmt(`SELECT SUM(d.debit) FROM (${BRANCH(false)}) d`))).toBe(1);
  });

  it('TABLE and ONLY name the journal tables too', () => {
    expect(REF.test('TABLE gl_journal_lines')).toBe(true);
    expect(flagged(stmt('SELECT SUM(jl.debit) FROM ONLY gl_journal_lines jl JOIN ONLY gl_journal_entries je ON je.id = jl.journal_entry_id'))).toBe(1);
    expect(flagged(stmt(`SELECT SUM(jl.debit) FROM ONLY gl_journal_lines jl JOIN ONLY gl_journal_entries je ON je.id = jl.journal_entry_id WHERE ${M}`))).toBe(0);
  });

  it('a marker in a LEFT JOIN ... ON counts only when the statement also guards on the joined row', () => {
    const left = (select: string, tail = '') =>
      `SELECT ${select} FROM gl_accounts ga LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id `
      + `LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted' AND ${M} ${tail} GROUP BY ga.id`;
    // The notes' bug: the ON clause blanks the entry but the line is still summed.
    expect(flagged(stmt(left('SUM(jl.debit - jl.credit)')))).toBe(1);
    expect(flagged(stmt(left('SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit - jl.credit END)')))).toBe(0);
    expect(flagged(stmt(left('SUM(jl.debit)', 'WHERE je.id IS NOT NULL')))).toBe(0);
  });

  it('a marker inside an EXISTS subselect does not vouch for the outer query, and an EXISTS needs none', () => {
    const outer = `SELECT SUM(jl.debit) FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE EXISTS (SELECT 1 FROM gl_journal_entries x WHERE ${M.replace('je.', 'x.')})`;
    expect(flagged(stmt(outer))).toBe(1);
    const existsOnly = `SELECT SUM(jl.debit) FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE ${M} AND EXISTS (SELECT 1 FROM gl_journal_lines z WHERE z.journal_entry_id = je.id)`;
    expect(flagged(stmt(existsOnly))).toBe(0);
  });

  it('the scopes of a statement are its SELECTs, set-operator branches included', () => {
    expect(selectScopes(`${BRANCH(true)} UNION ALL ${BRANCH(false)}`)).toHaveLength(2);
  });

  it('an ungated LEFT JOIN onto gl_journal_entries is found whatever its ON says, marked or not', () => {
    const base = (select: string, on: string, tail = '') =>
      `SELECT ${select} FROM gl_accounts ga LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id `
      + `LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id ${on} ${tail} GROUP BY ga.id`;
    expect(ungatedEntryLeftJoins(base('SUM(jl.debit)', "AND je.status = 'posted'"))).toEqual(['je']);
    expect(ungatedEntryLeftJoins(base('SUM(jl.debit)', `AND je.status = 'posted' AND ${M}`))).toEqual(['je']);
    expect(ungatedEntryLeftJoins(base('SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit END)', "AND je.status = 'posted'"))).toEqual([]);
    expect(ungatedEntryLeftJoins(base('SUM(jl.debit)', "AND je.status = 'posted'", 'WHERE je.id IS NOT NULL'))).toEqual([]);
  });

  const SUB = (tie: string) => `SELECT SUM(l.debit) FROM gl_journal_lines l WHERE l.journal_entry_id = ${tie}`;

  it('a CORRELATED subselect must be tied to a marked entries alias of an ENCLOSING scope', () => {
    const ok = `SELECT je.id, (${SUB('je.id')}) FROM gl_journal_entries je WHERE je.company_id = \${c} AND ${M}`;
    expect(correlatedToMarkedEntry(ok)).toBe(true);
    // Tied to something that is not an entries alias.
    expect(correlatedToMarkedEntry(`SELECT ga.id, (${SUB('ga.id')}) FROM gl_accounts ga`)).toBe(false);
    // The entries alias is not marked.
    expect(correlatedToMarkedEntry(`SELECT je.id, (${SUB('je.id')}) FROM gl_journal_entries je`)).toBe(false);
    // Outer SUM beside an uncorrelated marked EXISTS: the EXISTS gates nothing.
    const withExists = `SELECT SUM(l.debit) FROM gl_journal_lines l WHERE EXISTS (SELECT 1 FROM gl_journal_entries x WHERE ${M.replace('je.', 'x.')})`;
    expect(correlatedToMarkedEntry(withExists)).toBe(false);
    // Outer SUM beside a marked CTE it is not tied to.
    const withCte = `WITH ok AS (SELECT je.id FROM gl_journal_entries je WHERE ${M}) SELECT SUM(l.debit) FROM gl_journal_lines l, ok`;
    expect(correlatedToMarkedEntry(withCte)).toBe(false);
    // Tied to the CTE's alias from outside it: not an ancestor scope.
    const siblingTie = `WITH ok AS (SELECT je.id FROM gl_journal_entries je WHERE ${M}) SELECT (${SUB('je.id')}) FROM ok`;
    expect(correlatedToMarkedEntry(siblingTie)).toBe(false);
  });

  it('a CHAIN walk must read headers only', () => {
    const walk = (select: string) => `WITH RECURSIVE up AS (SELECT ${select} FROM gl_journal_entries r WHERE r.id = \${id} UNION ALL SELECT ${select.replace(/r\./g, 'p.')} FROM gl_journal_entries p JOIN up ON p.id = up.reversal_of_id) SELECT * FROM up`;
    expect(headersOnly(walk('r.id, r.reversal_of_id, r.reference'))).toBe(true);
    expect(headersOnly(walk('r.id, SUM(r.total_amount)'))).toBe(false);
    expect(headersOnly(`${walk('r.id')} UNION ALL SELECT l.debit FROM gl_journal_lines l`)).toBe(false);
    expect(headersOnly('SELECT 1')).toBe(false);
    // Naming the scope: the walk's own SELECTs are judged, a line-reading sibling is not smuggled in under them.
    expect(headersOnly(walk('r.id, r.reference'), 'SELECT r.id')).toBe(true);
    expect(headersOnly(walk('r.id, r.debit'), 'SELECT r.id')).toBe(false);
    expect(headersOnly(walk('r.id'), 'SELECT nothing here')).toBe(false);
  });
});
