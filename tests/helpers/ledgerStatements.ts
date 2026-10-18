/**
 * The rule behind tests/unit/guards/yearEndJournalCensus.test.ts, as functions, so the guard can be
 * run over PLANTED evasions as well as over the tree.
 *
 * A "ledger statement" is a template literal that reads gl_journal_lines or gl_journal_entries
 * (FROM / JOIN / comma join, schema-qualified or quoted). It is "figure-bearing" when it aggregates
 * (SUM / MAX / MIN / AVG / *_agg, any case, any spacing before the bracket), lists a money column of a
 * line (debit, credit, late_claim_base, a line-alias wildcard) or serialises a whole line row
 * (to_jsonb(jl) ...), which is what a TS-side `.reduce` over the rows needs.
 *
 * It "carries the marker" only when ITS OWN SQL (comments AND string literals stripped) holds
 * `<alias>.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}` where
 *   - the alias is bound to gl_journal_entries IN THAT STATEMENT (a marker on `x.source` for some
 *     other table does not count), and
 *   - the predicate is a CONJUNCT: preceded by WHERE / AND / ON (optionally an opening bracket) and not
 *     joined by OR, either side, anywhere in the bracket group and clause that holds it
 *     (`... OR TRUE`, `x OR marker`, `(marker AND a OR b)` are all neutralised markers).
 * An import, a TS comment, a SQL comment, a SQL string literal or a sibling statement does not count.
 */
import { templateLiterals, type TemplateLiteral } from './templateLiterals';

const TABLE = String.raw`(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?gl_journal_(?:lines|entries)"?`;
export const REF = new RegExp(String.raw`(?:\bFROM|\bJOIN|\bTABLE|,)\s*${TABLE}(?![\w"])`, 'i');

const MONEY = String.raw`(?:debit|credit|late_claim_base)`;
const AGGREGATE = String.raw`\b(?:SUM|MAX|MIN|AVG|ARRAY_AGG|STRING_AGG|JSONB_AGG|JSON_AGG|BOOL_AND|BOOL_OR)\s*\(`;
const WHOLE_ROW = String.raw`\b(?:to_jsonb|to_json|row_to_json|jsonb_agg|json_agg)\s*\(\s*\w+\s*\)`;
export const FIGURE = new RegExp(
  `${AGGREGATE}|${WHOLE_ROW}|\\bSELECT\\b[\\s\\S]*?\\b${MONEY}\\b[\\s\\S]*?\\bFROM\\b`, 'i');

const RESERVED = new Set(['ON', 'WHERE', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'JOIN', 'USING', 'GROUP', 'ORDER',
  'LIMIT', 'OFFSET', 'HAVING', 'UNION', 'FOR', 'WINDOW', 'SET', 'AS', 'NATURAL', 'LATERAL', 'RETURNING', 'EXCEPT', 'INTERSECT']);

/** SQL with comments and string literals removed, in ONE pass, so a quote inside a comment cannot pair wrongly. */
export function stripSql(s: string): string {
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s.startsWith('--', i)) { while (i < s.length && s[i] !== '\n') i += 1; out += ' '; continue; }
    if (s.startsWith('/*', i)) { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out += ' '; continue; }
    if (s[i] === "'") {
      i += 1;
      while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") i += 2; else if (s[i] === "'") break; else i += 1; }
      i += 1; out += "''"; continue;
    }
    out += s[i]!; i += 1;
  }
  return out;
}

/** The aliases a table is bound to in this statement (its own name counts: `gl_journal_entries.source`). */
function aliasesOf(body: string, table: 'lines' | 'entries'): Set<string> {
  const found = new Set<string>([`gl_journal_${table}`]);
  const re = new RegExp(String.raw`(?:\bFROM|\bJOIN|,)\s*(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?gl_journal_${table}"?(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?`, 'gi');
  for (const m of body.matchAll(re)) {
    const alias = m[1];
    if (alias && !RESERVED.has(alias.toUpperCase())) found.add(alias);
  }
  return found;
}

/** [start, end) of the innermost bracket group holding `index`, or the whole text. */
function enclosingGroup(body: string, index: number): [number, number] {
  let depth = 0;
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (body[i] === ')') depth += 1;
    else if (body[i] === '(') { if (depth === 0) { start = i + 1; break; } depth -= 1; }
  }
  depth = 0;
  let end = body.length;
  for (let i = index; i < body.length; i += 1) {
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')') { if (depth === 0) { end = i; break; } depth -= 1; }
  }
  return [start, end];
}

const CLAUSE = /\b(?:WHERE|ON|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|FOR|WINDOW|SELECT|FROM)\b/gi;

/** True when no OR can switch the predicate at [from, to) off: in its bracket group, within its clause. */
function isConjunct(body: string, from: number, to: number): boolean {
  if (!/(?:\bAND|\bWHERE|\bON)\s*\(*\s*$/i.test(body.slice(0, from))) return false;
  if (/^\s*\)*\s*(?:\bOR\b|\|\||::|[=<>!+\-*/])/i.test(body.slice(to))) return false;
  const [gs, ge] = enclosingGroup(body, from);
  // Blank nested groups so only this group's own level is read; the marker itself stays.
  let scope = '';
  let depth = 0;
  for (let i = gs; i < ge; i += 1) {
    const c = body[i]!;
    const inMarker = i >= from && i < to;
    if (c === '(') { depth += 1; scope += ' '; continue; }
    if (c === ')') { depth -= 1; scope += ' '; continue; }
    // The marker's own words ("DISTINCT FROM") must not read as clause keywords.
    scope += inMarker ? 'x' : depth > 0 ? ' ' : c;
  }
  const at = from - gs;
  const marks = [0, ...[...scope.matchAll(CLAUSE)].map((m) => m.index!), scope.length].sort((a, b) => a - b);
  const lo = [...marks].reverse().find((m) => m <= at) ?? 0;
  const hi = marks.find((m) => m > at) ?? scope.length;
  return !/\bOR\b/i.test(scope.slice(lo, hi));
}

const MARKER_RE = /(?:\b(\w+)\s*\.\s*)?\bsource\s+IS\s+DISTINCT\s+FROM\s+\$\{\s*YEAR_END_JOURNAL_SOURCE\s*\}/gi;

/**
 * A marker in the ON clause of a LEFT JOIN onto gl_journal_entries blanks the ENTRY's columns for a line it
 * excludes but does not drop the LINE: a SUM over the lines still adds it (drafts and the close alike). It
 * counts only if the statement also uses that alias outside its own ON clause: an IS NULL guard in the
 * aggregate, a column in the SELECT list or WHERE, or a later join that hangs off it.
 */
function leftJoinOnWithoutGuard(body: string, alias: string, markerAt: number): boolean {
  const join = new RegExp(String.raw`\bLEFT\s+(?:OUTER\s+)?JOIN\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?gl_journal_entries"?(?:\s+(?:AS\s+)?${alias})\b`, 'gi');
  for (const j of body.matchAll(join)) {
    const onStart = j.index! + j[0].length;
    if (markerAt < onStart) continue;
    const next = body.slice(onStart).search(/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|LEFT|RIGHT|INNER|FULL|CROSS|JOIN)\b/i);
    const onEnd = next < 0 ? body.length : onStart + next;
    if (markerAt >= onEnd) continue;
    const outside = body.slice(0, onStart) + ' ' + body.slice(onEnd);
    return !new RegExp(String.raw`\b${alias}\s*\.\s*\w+`, 'i').test(outside);
  }
  return false;
}

/**
 * LEFT JOINs onto gl_journal_entries whose alias the statement never uses outside that join's own ON clause.
 * Whatever the ON says (posted, a date, the close marker), such a join blanks the entry's columns but keeps the
 * line, so a SUM over the lines counts draft and excluded entries. An allow-list category excuses the year-end
 * marker; it does not excuse this.
 */
export function ungatedEntryLeftJoins(body: string): string[] {
  const out: string[] = [];
  const join = /\bLEFT\s+(?:OUTER\s+)?JOIN\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?gl_journal_entries"?(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  for (const j of body.matchAll(join)) {
    const alias = j[1] && !RESERVED.has(j[1].toUpperCase()) ? j[1] : 'gl_journal_entries';
    const onStart = j.index! + j[0].length;
    const next = body.slice(onStart).search(/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|LEFT|RIGHT|INNER|FULL|CROSS|JOIN)\b/i);
    const onEnd = next < 0 ? body.length : onStart + next;
    const outside = body.slice(0, j.index!) + ' ' + body.slice(onEnd);
    if (!new RegExp(String.raw`\b${alias}\s*\.\s*\w+`, 'i').test(outside)) out.push(alias);
  }
  return out;
}

/** Whether this SELECT's own SQL carries the marker as a live conjunct on its gl_journal_entries alias. */
export function bodyCarriesMarker(body: string): boolean {
  const entries = aliasesOf(body, 'entries');
  for (const m of body.matchAll(MARKER_RE)) {
    const alias = m[1];
    if (alias ? !entries.has(alias) : entries.size > 2) continue;
    if (alias && leftJoinOnWithoutGuard(body, alias, m.index!)) continue;
    if (isConjunct(body, m.index!, m.index! + m[0].length)) return true;
  }
  return false;
}

interface Scope { text: string; checked: boolean }

/** SELECT bodies of a statement: each bracketed SELECT/WITH group and the outer text, split at UNION / INTERSECT / EXCEPT. */
export function selectScopes(body: string): Scope[] {
  const scopes: Scope[] = [];
  function walk(text: string, checked: boolean): void {
    let outer = '';
    for (let i = 0; i < text.length;) {
      if (text[i] !== '(') { outer += text[i]!; i += 1; continue; }
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) { if (text[j] === '(') depth += 1; else if (text[j] === ')') depth -= 1; j += 1; }
      const inner = text.slice(i + 1, j - 1);
      if (/^\s*(?:SELECT|WITH|VALUES)\b/i.test(inner)) {
        // An existence / membership subselect gates nothing in the outer query; it is a named limit.
        const guardOnly = /\b(?:EXISTS|IN|ANY|ALL|SOME)\s*$/i.test(outer);
        walk(inner, !guardOnly);
        outer += ' ';
      } else {
        outer += text.slice(i, j);
      }
      i = j;
    }
    for (const branch of outer.split(/\b(?:UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\b/i)) scopes.push({ text: branch, checked });
  }
  walk(body, true);
  return scopes;
}

/** Every SELECT that reads the journal tables (other than an existence test) carries its own live marker. */
export function allScopesMarked(body: string): boolean {
  const reading = selectScopes(body).filter((s) => s.checked && REF.test(s.text));
  return reading.length > 0 && reading.every((s) => bodyCarriesMarker(s.text));
}

/** Whether the SELECT list names a wildcard of an alias bound to gl_journal_lines. */
function lineWildcard(body: string): boolean {
  const lines = aliasesOf(body, 'lines');
  return [...body.matchAll(/\b(\w+)\s*\.\s*\*/g)].some((m) => lines.has(m[1]!));
}

export interface Stmt { f: string; t: TemplateLiteral; body: string }

export function ledgerStatements(f: string, src: string): Stmt[] {
  if (!/gl_journal_/i.test(src)) return [];
  return templateLiterals(src)
    .map((t) => ({ f, t, body: stripSql(t.text) }))
    .filter(({ body }) => REF.test(body));
}

export const isSql = (s: Stmt): boolean => s.t.tag === 'sql' || s.t.tag === 'tx';
export const isFigure = (s: Stmt): boolean => isSql(s) && (FIGURE.test(s.body) || lineWildcard(s.body));
export const carriesMarker = (s: Stmt): boolean => allScopesMarked(s.body);

/** Figure-bearing statements of a source with no marker of their own. */
export function unmarkedFigureStatements(f: string, src: string): Stmt[] {
  return ledgerStatements(f, src).filter((s) => isFigure(s) && !carriesMarker(s));
}
