/**
 * The rule behind tests/unit/guards/yearEndJournalCensus.test.ts, as functions, so the guard can be
 * run over PLANTED evasions as well as over the tree.
 *
 * A "ledger statement" is a template literal that reads gl_journal_lines or gl_journal_entries
 * (FROM / JOIN). It is "figure-bearing" when it aggregates (SUM / MAX / MIN / AVG / *_agg, any case,
 * any spacing before the bracket) or lists line amounts (debit / credit / a line wildcard in its
 * SELECT list), which is what a TS-side `.reduce` over the rows needs. It "carries the marker" only
 * when ITS OWN SQL text, comments stripped, holds `source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}`:
 * an import, a TS comment, a SQL comment or a sibling statement does not count.
 */
import { templateLiterals, type TemplateLiteral } from './templateLiterals';

export const REF = /\b(?:FROM|JOIN)\s+gl_journal_(?:lines|entries)\b/i;
export const FIGURE = new RegExp(
  String.raw`\b(?:SUM|MAX|MIN|AVG|ARRAY_AGG|STRING_AGG|JSONB_AGG|BOOL_AND|BOOL_OR)\s*\(`
  + String.raw`|\bSELECT\b[\s\S]*?(?:\b(?:debit|credit)\b|\b(?:jl|gjl|jl\d|l)\.\*)[\s\S]*?\bFROM\b`,
  'i',
);
export const MARKER = /\bsource\s+IS\s+DISTINCT\s+FROM\s+\$\{\s*YEAR_END_JOURNAL_SOURCE\s*\}/i;

export const stripSqlComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');

export interface Stmt { f: string; t: TemplateLiteral; body: string }

export function ledgerStatements(f: string, src: string): Stmt[] {
  if (!src.includes('gl_journal_')) return [];
  return templateLiterals(src)
    .map((t) => ({ f, t, body: stripSqlComments(t.text) }))
    .filter(({ body }) => REF.test(body));
}

export const isSql = (s: Stmt): boolean => s.t.tag === 'sql' || s.t.tag === 'tx';
export const isFigure = (s: Stmt): boolean => isSql(s) && FIGURE.test(s.body);
export const carriesMarker = (s: Stmt): boolean => MARKER.test(s.body);

/** Figure-bearing statements of a source with no marker of their own. */
export function unmarkedFigureStatements(f: string, src: string): Stmt[] {
  return ledgerStatements(f, src).filter((s) => isFigure(s) && !carriesMarker(s));
}
