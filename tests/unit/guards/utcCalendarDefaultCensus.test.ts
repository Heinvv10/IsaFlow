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
 * Scope: pages/** (excluding pages/api) and src/components/**.
 * Every ALLOWED entry is a deliberate use, keyed by file with the reason.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const PATTERN =
  /\.toISOString\(\)\s*\.\s*(?:split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]|slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\))/g;

/** file -> [expected hit count, reason]. */
const ALLOWED: Record<string, [number, string]> = {
  'pages/accounting/gl-import.tsx': [1, 'Excel cell Date from the xlsx parser (UTC-based), not a local-midnight default'],
  'pages/accounting/items/[itemId].tsx': [1, 'created_at is a DB instant, not a calendar default (display only)'],
  'pages/accounting/reports/balance-sheet.tsx': [1, 'new Date("YYYY-MM-DD") is UTC midnight and round-trips through UTC; local getters would break west of UTC'],
  'pages/accounting/reports/income-statement.tsx': [2, 'prior-period maths on new Date("YYYY-MM-DD") UTC midnights; UTC in, UTC out'],
  'src/components/accounting/bankFeeds/BankFeedCard.tsx': [1, 'lastSyncAt is a server instant, not a calendar default'],
};

function scan(): Map<string, number> {
  const files = execFileSync('git', ['ls-files', '-z', 'pages', 'src/components'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('pages/api/'));
  const hits = new Map<string, number>();
  for (const f of files) {
    const n = (readFileSync(path.join(ROOT, f), 'utf8').match(PATTERN) ?? []).length;
    if (n > 0) hits.set(f, n);
  }
  return hits;
}

describe('UTC calendar-default census (pages/**, src/components/**)', () => {
  const hits = scan();

  it('no UI file derives a calendar date via toISOString() outside the allowlist', () => {
    const offenders = [...hits].filter(([f, n]) => n !== (ALLOWED[f]?.[0] ?? 0)).map(([f, n]) => `${f} (${n})`);
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still matches (no stale exemptions)', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !hits.has(f));
    expect(stale).toEqual([]);
  });
});
