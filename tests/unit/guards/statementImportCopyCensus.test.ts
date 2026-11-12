/**
 * IsaFlow imports bank statements the user uploads. It has no live bank feed
 * and no browser connector, so the banking copy that used to offer one must
 * say "statement import" only (11 Nov 2026 audit, item b.5).
 *
 * Scope is a pinned file list, not the whole repo: the statement parsers and
 * bank pickers legitimately name ABSA as a bank.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tracked = (...paths: string[]): string[] =>
  execFileSync('git', ['ls-files', '--', ...paths], { encoding: 'utf8' }).split('\n').filter(Boolean);

const COPY_FILES = tracked(
  'src/components/accounting/navSections/banking.ts',
  'src/components/onboarding/setupGuideConfig.ts',
  'pages/accounting/bank/provisional.tsx',
  'pages/accounting/bank/statements',
  'src/lib/email-templates-auth.ts',
);

const FORBIDDEN: Array<[string, RegExp]> = [
  ['bank feed', /bank ?feeds?/i],
  ['the old Bank Feeds route', /bank-feeds/],
  ['ABSA', /\bABSA\b/i],
  ['automatic import', /automatic(ally)?\b.*\bimport/i],
  ['Bank Connections', /bank connections?/i],
];

describe('statement-import-only banking copy', () => {
  it('covers every pinned file', () => {
    expect(COPY_FILES.length).toBeGreaterThanOrEqual(6);
  });

  it('no pinned file mentions a bank feed, ABSA, automatic import or bank connections', () => {
    for (const file of COPY_FILES) {
      const text = readFileSync(file, 'utf8');
      for (const [name, re] of FORBIDDEN) expect(re.test(text), `${file}: ${name}`).toBe(false);
    }
  });

  it('the Bank Feeds page and its components are gone', () => {
    expect(tracked('pages/accounting/bank-feeds', 'src/components/accounting/bankFeeds')).toEqual([]);
  });
});
