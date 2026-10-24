/**
 * One code path builds financial years and their periods: the database generator
 * (fiscal_year_ensure + fiscal_periods_generate, migration 942) behind
 * gl/fiscalYearGenerator. No application code INSERTs into fiscal_periods or
 * fiscal_years itself.
 *
 * Scans src/, pages/ and scripts/ (migrations excluded: they define the
 * generator), comments removed. A new writer fails here; so does an allow-list
 * entry whose file no longer writes (delete it, do not keep it).
 *
 * A source-text ratchet: the behaviour (one generator, years linked by
 * fiscal_periods_link_year for legacy writers) is pinned by
 * tests/integration/fiscal-years-generator.int.test.ts. Reads `git ls-files`,
 * so a new untracked file is not scanned until it is added.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const WRITE = /\bINSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?fiscal_(?:periods|years)\b/i;

/** file -> reason. */
const ALLOWED: Readonly<Record<string, string>> = {
  'scripts/provision-isademo2.ts':
    'one-off demo seed script run by hand against a throwaway database; its rows are linked to their year by fiscal_periods_link_year',
  'scripts/seed-historical-data.mjs':
    'legacy demo-history seed script, not run by the app; its rows are linked to their year by fiscal_periods_link_year',
  'src/modules/accounting/services/gl/financialYearEndChangeUndo.ts':
    'restores the snapshot rows of years a change of year end replaced, with their original ids (PR 2)',
};

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .replace(/(^|\n)\s*--[^\n]*/g, '$1');
}

function files(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(tsx?|mjs|js|sql)$/.test(f) && !f.startsWith('scripts/migrations/'));
}

describe('fiscal period / year writer census', () => {
  const writers = files().filter((f) => WRITE.test(code(readFileSync(resolve(ROOT, f), 'utf8'))));

  it('no file outside the allow-list INSERTs into fiscal_periods or fiscal_years', () => {
    expect(writers.filter((f) => !(f in ALLOWED))).toEqual([]);
  });

  it('no allow-list entry is stale (entries for files not yet on this branch are ignored)', () => {
    const tracked = new Set(files());
    expect(Object.keys(ALLOWED).filter((f) => tracked.has(f) && !writers.includes(f))).toEqual([]);
  });

  it('sees a write when there is one (the pattern is not dead)', () => {
    expect(WRITE.test(code('await sql`INSERT INTO fiscal_periods (company_id) VALUES (1)`'))).toBe(true);
    expect(WRITE.test(code('// INSERT INTO fiscal_periods in a comment'))).toBe(false);
  });
});
