/**
 * W1-01 census (a source-text ratchet, NOT a behaviour test — behaviour lives in
 * tests/unit/lib/dateUtilsLocalCalendar.test.ts).
 *
 * `x.toISOString().split('T')[0]` / `.slice(0, 10)` / `.substring(0, 10)` names
 * the UTC day. In SAST (UTC+2) a locally-built Date such as `new Date(y, m, 1)`
 * is 22:00 UTC the previous day, so month reports opened on 31 Aug and VAT201
 * defaulted to 07/31..08/30. UI calendar defaults must use `localISODate` /
 * `monthStartISO` / `monthEndISO` / `prevMonthRange` from `@/lib/dateUtils`.
 *
 * Scope: pages/** (excluding pages/api), src/components/**, src/utils/**, src/hooks/**,
src/contexts/** — enumerated from the filesystem so an untracked file cannot slip past.
Detects: toISOString().split('T')[0] / .slice|substring(0, 10|7), the same on a
parenthesised expression containing toISOString, and getUTC and setUTC calendar reads.
Server-side code (src/lib/mcp/tools/*, services) is out of scope: K-235.
 * Every ALLOWED entry is a deliberate use, keyed by file with the reason.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const SCOPE = ['pages', 'src/components', 'src/utils', 'src/hooks', 'src/contexts'];
const CHAIN =
  /\.toISOString\(\)\s*\.\s*(?:split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]|(?:slice|substring)\(\s*0\s*,\s*(?:10|7)\s*\))/g;
const PAREN_SPLIT = /\)\s*\.\s*split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]/g;
const UTC_CALENDAR = /\b(?:get|set)UTC(?:FullYear|Month|Date|Day)\s*\(/g;

/** Count `(<expr containing toISOString>).split('T')[0]` by walking back to the opening paren. */
function countParenSplits(src: string): number {
  let n = 0;
  for (const m of src.matchAll(PAREN_SPLIT)) {
    let depth = 0;
    let i = m.index!;
    for (; i >= 0; i--) {
      if (src[i] === ')') depth++;
      else if (src[i] === '(' && --depth === 0) break;
    }
    if (i >= 0 && src.slice(i, m.index).includes('toISOString')) n++;
  }
  return n;
}

function countHits(src: string): number {
  return (src.match(CHAIN) ?? []).length + countParenSplits(src) + (src.match(UTC_CALENDAR) ?? []).length;
}

/** file -> [expected hit count, reason]. */
const ALLOWED: Record<string, [number, string]> = {
  'pages/accounting/gl-import.tsx': [1, 'Excel cell Date from the xlsx parser (UTC-based), not a local-midnight default'],
  'pages/accounting/reports/income-statement.tsx': [2, 'prior-period maths on new Date("YYYY-MM-DD") UTC midnights; UTC in, UTC out'],
  'src/components/accounting/invoicePeriod.ts': [1, 'days-in-month arithmetic on a Date.UTC-built Date, never "today"'],
};

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && !(dir === 'pages' && e.name === 'api')) walk(rel, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
}

function scan(): Map<string, number> {
  const files: string[] = [];
  for (const d of SCOPE) walk(d, files);
  const hits = new Map<string, number>();
  for (const f of files) {
    const n = countHits(readFileSync(path.join(ROOT, f), 'utf8'));
    if (n > 0) hits.set(f, n);
  }
  return hits;
}

describe('UTC calendar-default census', () => {
  const hits = scan();

  it('detectors fire on the shapes they claim to catch', () => {
    expect(countHits("new Date().toISOString().slice(0, 7)")).toBe(1);
    expect(countHits("(v instanceof Date ? v.toISOString() : v).split('T')[0]")).toBe(1);
    expect(countHits("d.getUTCFullYear()")).toBe(1);
    expect(countHits("(s as string).split('T')[0]")).toBe(0);
    expect(countHits("localISODate(d).slice(0, 7)")).toBe(0);
  });

  it('no UI file derives a calendar date via UTC outside the allowlist', () => {
    const offenders = [...hits].filter(([f, n]) => n !== (ALLOWED[f]?.[0] ?? 0)).map(([f, n]) => `${f} (${n})`);
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still matches (no stale exemptions)', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !hits.has(f));
    expect(stale).toEqual([]);
  });
});
