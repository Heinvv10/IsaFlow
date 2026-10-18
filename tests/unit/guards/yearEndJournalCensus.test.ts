/**
 * G-01 census, mechanised PER STATEMENT. Every SQL statement that reads gl_journal_lines or
 * gl_journal_entries and produces a figure must leave out the posted year-end closing journal
 * through the ONE shared marker (`je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}`,
 * gl/yearEndJournalSource.ts) inside ITS OWN SQL, or be classified below with a CATEGORY and the
 * category's one-line justification. The rule itself is tests/helpers/ledgerStatements.ts, which
 * also runs over PLANTED evasions further down.
 *
 * The first version counted one marker per FILE, so a marked statement vouched for every unmarked
 * one beside it. Now each template literal is read on its own (tests/helpers/templateLiterals.ts):
 * an import, a TS or SQL comment, or a sibling statement does not count. Figures aggregated in JS
 * are caught through the statement that feeds them (debit / credit / a line wildcard in its SELECT).
 * Templates that are not `sql`/`tx` statements (composed fragments, plain strings handed to a
 * runner) are listed separately, and so is any file that exposes `jl.debit`/`jl.credit` as a
 * report field. A CASH entry is verified, not trusted: every statement it covers must filter to
 * cash or bank accounts. docs/fixes/g01-census.md is the long form.
 *
 * NAMED LIMITS (what a source-text rule cannot see; each is why the reader table in
 * g01-every-reader.int.test.ts exists): SQL assembled by string concatenation or a function that returns
 * text; SQL in a database view or function (migrations); `sql.unsafe`/`pool.query` over a variable; SQL a
 * model writes (nl-query); a figure read through another table (the gl_account_balances cache, bank
 * transaction amounts); `count(*)` (a number of rows, not a balance, so deliberately not a figure); a
 * JavaScript regex literal that looks like a string to the scanner (the scanner knows the common shapes).
 * Also not seen: an uncorrelated EXISTS / IN subselect carrying the marker (it gates nothing in the outer
 * query, and the rule skips existence tests altogether, so a figure hidden inside one is a named limit); a
 * marker on a DIFFERENT gl_journal_entries alias than the one the figure's lines join (a self-join, `orig`);
 * a join condition that makes the marker true for every row.
 * Quoted strings that merely NAME the tables are census-listed below so a new one is a decision.
 *
 * A source-text ratchet, not a behaviour test: the behaviour is pinned by
 * tests/integration/g01-every-reader.int.test.ts and g01-year-end-journal-excluded-from-reports.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { quotedStrings } from '../../helpers/templateLiterals';
import {
  bodyCarriesMarker, carriesMarker, isFigure, isSql, ledgerStatements, selectScopes, type Stmt,
} from '../../helpers/ledgerStatements';
import {
  CASH_FILTER, CATEGORIES, COMPOSED, CORRELATED_ON, entries, key, RECLASS_FLAG, STRINGS,
} from '../../helpers/yearEndCensusTable';

const ROOT = resolve(__dirname, '../../..');
function files(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
}

const sources = files().map((f) => ({ f, src: readFileSync(resolve(ROOT, f), 'utf8') }));
const statements: Stmt[] = sources.flatMap(({ f, src }) => ledgerStatements(f, src));
const figures = statements.filter(isFigure);

/** The entries that cover this statement: a whole-file entry, or one whose substring it contains. */
const covers = (s: Stmt) => entries.filter(([f, , m]) => key(f) === s.f && (m === undefined || s.body.includes(m)));

describe('G-01: the year-end closing journal is excluded through one shared marker, per statement', () => {
  it('finds the statements it is meant to police', () => {
    expect(figures.length).toBeGreaterThan(150);
    expect(figures.filter(carriesMarker).length).toBeGreaterThan(70);
  });

  it('every figure-producing statement carries the marker or is classified', () => {
    const unclassified = figures.filter((s) => !carriesMarker(s) && covers(s).length === 0)
      .map((s) => `${s.f}:${s.t.line}`);
    expect(unclassified).toEqual([]);
  });

  it('no allow-list entry is stale (it must cover at least one unmarked figure statement)', () => {
    const stale = entries.filter(([f, , m]) => !figures.some((s) =>
      !carriesMarker(s) && s.f === key(f) && (m === undefined || s.body.includes(m))))
      .map(([f, , m]) => (m ? `${f} (${m})` : f));
    expect(stale).toEqual([]);
  });

  it('every CASH entry is verified: each statement it covers filters to cash or bank accounts', () => {
    const offenders = figures.filter((s) => !carriesMarker(s)
      && covers(s).some(([, c]) => c === 'CASH') && !CASH_FILTER.test(s.body))
      .map((s) => `${s.f}:${s.t.line}`);
    expect(offenders).toEqual([]);
  });

  it('every RECLASS entry is verified: the statement flags the close so the partition can skip it', () => {
    const offenders = figures.filter((s) => !carriesMarker(s)
      && covers(s).some(([, c]) => c === 'RECLASS') && !RECLASS_FLAG.test(s.body))
      .map((s) => `${s.f}:${s.t.line}`);
    expect(offenders).toEqual([]);
  });

  it('every CORRELATED entry is verified: tied to an entry id, with the outer query carrying the marker', () => {
    const offenders = figures.filter((s) => !carriesMarker(s)
      && covers(s).some(([, c]) => c === 'CORRELATED')
      && !(CORRELATED_ON.test(s.body) && selectScopes(s.body).some((sc) => /\bFROM\s+gl_journal_entries\b/i.test(sc.text) && bodyCarriesMarker(sc.text))))
      .map((s) => `${s.f}:${s.t.line}`);
    expect(offenders).toEqual([]);
  });

  it('every category used has its one-line justification, and none is unused', () => {
    const used = new Set<string>([...entries.map(([, c]) => c), ...COMPOSED.map(([, c]) => c), ...STRINGS.map(([, c]) => c)]);
    expect([...used].filter((c) => !(c in CATEGORIES))).toEqual([]);
    expect(Object.keys(CATEGORIES).filter((c) => !used.has(c))).toEqual([]);
  });

  it('a template that is not an sql/tx statement but names the journal tables is classified', () => {
    const composed = statements.filter((s) => !isSql(s)).map((s) => s.f);
    const unlisted = [...new Set(composed)].filter((f) => !COMPOSED.some(([c]) => key(c) === f));
    expect(unlisted).toEqual([]);
    const stale = COMPOSED.filter(([c]) => !composed.includes(key(c))).map(([c]) => c);
    expect(stale).toEqual([]);
  });

  it('a quoted string that names the journal tables is classified (SQL that is not a tagged statement)', () => {
    const NAMES = /gl_journal_(?:lines|entries)/i;
    const hits = sources.filter(({ src }) => NAMES.test(src))
      .filter(({ src }) => quotedStrings(src).some((s) => NAMES.test(s.text))).map(({ f }) => f);
    expect(hits.length).toBeGreaterThan(3);
    expect(hits.filter((f) => !STRINGS.some(([c]) => key(c) === f))).toEqual([]);
    expect(STRINGS.filter(([c]) => !hits.includes(key(c))).map(([c]) => c)).toEqual([]);
  });

  it('a file that exposes jl.debit / jl.credit as a report field is a classified composer', () => {
    const exposing = sources
      .filter(({ src }) => /sqlExpr:\s*['"`][^'"`]*\b(?:jl|gjl)\.(?:debit|credit)/.test(src))
      .map(({ f }) => f);
    expect(exposing.length).toBeGreaterThan(0);
    expect(exposing.filter((f) => !COMPOSED.some(([c]) => key(c) === f))).toEqual([]);
  });

  it('nobody inlines the literal predicate again', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const inline = sources
      .filter(({ f, src }) => !f.endsWith('yearEndJournalSource.ts') && /DISTINCT FROM 'year_end'/.test(code(src)))
      .map(({ f }) => f);
    expect(inline).toEqual([]);
  });
});
