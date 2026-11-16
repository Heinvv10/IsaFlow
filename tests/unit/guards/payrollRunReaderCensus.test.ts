/**
 * Wave 6 F9: the run-keyed reader census, BY TABLE (FQb1 / FQb2 / FQc).
 *
 * THIS IS A RATCHET (a source-text census), NOT A BEHAVIOUR TEST. Until FQx drops it, payroll_run_headers is
 * UNIQUE (company_id, period_year, period_month). Every reader that leans on that (one run per company-month) must
 * be converted before FQx ships. This test makes sure every reader has been LOOKED AT and classified once:
 *
 *   S  correct with several runs in a month: a sum, an EXISTS, a list, or a read/write by run id;
 *   R  assumes one run per company-month (a lookup by month, LIMIT 1 / find / a Map keyed by month, an ON CONFLICT
 *      on the month), or takes a run's period dates from its month (right for a monthly run, regular or off-cycle;
 *      wrong for weekly/fortnightly, so owned by FQc, spec F2);
 *   L  a label only.
 *
 * Owners: FQb1 (payroll services, pages/api/payroll, MCP payroll tools), FQb2 (the rest), FQb2/EF (files EF owns
 * until #1490 merges), FQc (the year-to-date bound, the run inputs and the period dates, spec §3a/F2).
 * The behavioural proof of each converted R row is its two-runs-in-one-month integration case.
 *
 * How it matches: every line of a tracked, non-test .ts/.tsx file under src/ or pages/ that names one of the
 * tables (whole word) and is not a // or * comment line. Each file's hits, in order, must equal its rows' `text`
 * (the trimmed line), so a new reader, a changed reader line or a removed one fails. `line` is where the row was
 * when classified; it is reported, not compared, so an unrelated edit above a reader does not turn this red.
 * `consumers` are rows the table scan cannot see (a month lookup over rows a service returned, the F2 bounds);
 * each must still exist verbatim.
 *
 * `orderKeys` (the fourth rule, review #1507): a converted reader's ordering often sits on a line that names no table
 * (`ORDER BY ${runOrderKeySql('h')} DESC`). Every non-comment line outside payrollRunOrder.ts that calls
 * runOrderKeySql( or runOrderColumnsSql( is pinned verbatim, per file, in order, so flipping DESC to ASC, dropping a
 * call or adding one fails here.
 *
 * Named limits: a reader that reaches these tables through a view, a SQL function (migrations 951/979) or a
 * runtime-built table name is not seen; a consumer keyed by month that names no table is seen only if listed; a key
 * aliased into a column (sdlLeviabilityService's `AS k`) is pinned where it is built, not where `k` is ordered (the
 * integration mutants cover that line).
 * When this test fails on a new line: read the query, add ONE row classified honestly, with its owner and why.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

interface Row { line: number; text: string; class: string; owner: string; why: string }
interface Consumer extends Row { file: string }
interface Census { tables: string[]; orderKeys: Record<string, string[]>; consumers: Consumer[]; rows: Record<string, Row[]> }

const census = JSON.parse(readFileSync(resolve(__dirname, 'payrollRunReaderCensus.json'), 'utf8')) as Census;

const CLASSES = new Set(['S', 'R', 'L']);
const OWNERS = new Set(['FQb1', 'FQb2', 'FQb2/EF', 'FQc']);
const FQB1_PATH = /^(src\/modules\/accounting\/services\/payroll\/|pages\/api\/payroll\/|src\/lib\/mcp\/tools\/(payroll|writePayroll))/;

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
}

const COMMENT = /^\s*(\/\/|\*|\/\*)/;

/** file -> the trimmed lines that name a census table, in file order. */
function scanHits(tables: string[], files: string[], read: (f: string) => string): Map<string, Array<{ line: number; text: string }>> {
  const named = new RegExp(`\\b(${tables.join('|')})\\b`);
  const out = new Map<string, Array<{ line: number; text: string }>>();
  for (const f of files) {
    const hits = read(f).split('\n').flatMap((text, i) => (named.test(text) && !COMMENT.test(text) ? [{ line: i + 1, text: text.trim() }] : []));
    if (hits.length > 0) out.set(f, hits);
  }
  return out;
}

const fmt = (f: string, h: { line: number; text: string }) => `${f}:${h.line}  ${h.text}`;

describe('payroll run reader census (wave 6 F9, by table)', () => {
  const hits = scanHits(census.tables, sourceFiles(), (f) => readFileSync(resolve(ROOT, f), 'utf8'));

  it('classifies every line that names a census table, in order, and nothing stale', () => {
    const unclassified: string[] = [];
    const stale: string[] = [];
    for (const [f, found] of hits) {
      const rows = census.rows[f] ?? [];
      const texts = rows.map((r) => r.text);
      // Order-aware: the i-th hit must be the i-th row. A mismatch reports the hit and the row it displaced.
      found.forEach((h, i) => { if (texts[i] !== h.text) unclassified.push(fmt(f, h)); });
      rows.slice(found.length).forEach((r) => stale.push(fmt(f, r)));
    }
    for (const [f, rows] of Object.entries(census.rows)) {
      if (!hits.has(f)) rows.forEach((r) => stale.push(fmt(f, r)));
    }
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it('pins every runOrderKeySql( / runOrderColumnsSql( call site verbatim (the fourth rule)', () => {
    const call = /\brunOrder(Key|Columns)Sql\(/;
    const found: Record<string, string[]> = {};
    for (const f of sourceFiles().filter((x) => !x.endsWith('/payrollRunOrder.ts'))) {
      const lines = readFileSync(resolve(ROOT, f), 'utf8').split('\n').filter((l) => call.test(l) && !COMMENT.test(l)).map((l) => l.trim());
      if (lines.length > 0) found[f] = lines;
    }
    expect(found).toEqual(census.orderKeys);
  });

  it('finds every listed consumer line verbatim', () => {
    const missing = census.consumers.filter((c) => {
      const lines = readFileSync(resolve(ROOT, c.file), 'utf8').split('\n').map((l) => l.trim());
      return !lines.includes(c.text);
    }).map((c) => fmt(c.file, c));
    expect(missing).toEqual([]);
  });

  it('gives every row a class, an owner that may own it, and a reason', () => {
    const all: Array<[string, Row]> = [
      ...Object.entries(census.rows).flatMap(([f, rows]) => rows.map((r): [string, Row] => [f, r])),
      ...census.consumers.map((c): [string, Row] => [c.file, c]),
    ];
    const bad = all.filter(([f, r]) => !CLASSES.has(r.class) || !OWNERS.has(r.owner) || r.why.trim() === ''
      // FQb1 converts only in its own paths, FQb2 only outside them; FQb2/EF and FQc rows may sit anywhere.
      || (r.owner === 'FQb1' && !FQB1_PATH.test(f)) || (r.owner === 'FQb2' && FQB1_PATH.test(f)))
      .map(([f, r]) => `${fmt(f, r)}  [${r.class} ${r.owner}]`);
    expect(bad).toEqual([]);
  });
});
