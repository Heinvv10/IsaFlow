/**
 * bank/bankAccountGuard holds the bank account FOR SHARE for a WRITE, so a deactivation or retype cannot land between
 * its check and the write (WP2-1 r2). `{ lock: false }` drops that lock and is for READ-ONLY callers only (r4).
 * Integration tests catch an unlocked read on two write routes only (breaker, PR #1449 r4: `{ lock: false }` appended
 * to each write caller in turn left every other one green), so this census pins WHERE an options argument may reach
 * the guard: a call to `assertBankAccountInCompany` or `bankGlAccountBelongsToCompany` with a third argument, in any
 * spelling (a literal, a `READ_ONLY` const, a forwarded `opts`), must be one of the allowed read sites below. Any new
 * one fails until it is listed here — with the reason it writes nothing.
 *
 * Files are read from the working tree (tracked AND untracked), so a new caller fails before it is committed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const GUARD_FNS = ['assertBankAccountInCompany', 'bankGlAccountBelongsToCompany'];

/** `file :: third argument` → how many times. Every entry is a read, or the one pass-through. */
const ALLOWED: Record<string, number> = {
  // bank_statement_coverage and get_opening_balances: read tools (scope read:*), they write nothing.
  'src/lib/mcp/tools/bankCoverage.ts :: READ_ONLY': 2,
  // The preview parses a file and counts duplicates; it writes nothing (the commit re-checks with the lock).
  'pages/api/accounting/bank-transactions-bulk-preview.ts :: { lock: false }': 1,
  // bankGlAccountBelongsToCompany forwards its caller's options to the guard: the calls above are what it receives.
  'src/modules/accounting/services/bank/bankStatementImportService.ts :: opts': 1,
};

const sourceFiles = (): string[] =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'pages', 'scripts'],
    { encoding: 'utf8' }).split('\n').filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'));

/** Comments out, so a doc comment that names `{ lock: false }` is not a call. Strings are left alone. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** The top-level arguments of the call whose `(` is at `open`. */
function callArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth === 0) {
        const last = text.slice(start, i).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error(`unterminated call at ${open}`);
}

/** Every `file :: third argument` of a guard call in `files` (definitions and imports are not calls). */
function optionSites(files: Array<[string, string]>): string[] {
  const sites: string[] = [];
  for (const [file, raw] of files) {
    const text = stripComments(raw);
    for (const fn of GUARD_FNS) {
      for (const m of text.matchAll(new RegExp(`(?<!function\\s+)\\b${fn}\\s*\\(`, 'g'))) {
        const args = callArgs(text, m.index! + m[0].length - 1);
        if (args.length >= 3) sites.push(`${file} :: ${args.slice(2).join(', ').replace(/\s+/g, ' ')}`);
      }
    }
  }
  return sites;
}

const tally = (sites: string[]) => sites.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});

describe('only read-only callers pass options (and so `{ lock: false }`) to the bank-account guard', () => {
  const files = sourceFiles().map((f): [string, string] => [f, readFileSync(f, 'utf8')]);

  it('scans the callers it must see', () => {
    const callers = files.filter(([, t]) => GUARD_FNS.some((fn) => t.includes(`${fn}(`))).map(([f]) => f);
    expect(callers.length).toBeGreaterThanOrEqual(15);
    expect(callers).toContain('src/lib/mcp/tools/writeBankImport.ts');
  });

  it('every guard call with an options argument is an allowed read site, and no more of them', () => {
    expect(tally(optionSites(files))).toEqual(ALLOWED);
  });

  it('bankCoverage READ_ONLY is exactly { lock: false } (no other option rides in on it)', () => {
    const text = readFileSync('src/lib/mcp/tools/bankCoverage.ts', 'utf8');
    expect(text).toMatch(/const READ_ONLY = \{ lock: false \} as const;/);
  });

  it('flags a write caller that passes { lock: false }, a const, or forwarded options (the detector itself)', () => {
    const fake: Array<[string, string]> = [['src/lib/mcp/tools/writeBankImport.ts', [
      'await bankGlAccountBelongsToCompany(ctx.companyId, id, { lock: false });',
      'await assertBankAccountInCompany(c, id, NO_LOCK); // trailing comment',
      '/* bankGlAccountBelongsToCompany(a, b, { lock: false }) */ await assertBankAccountInCompany(c, id);',
      'export async function assertBankAccountInCompany(companyId, glAccountId, opts = {}) {}',
    ].join('\n')]];
    expect(optionSites(fake).sort()).toEqual([
      'src/lib/mcp/tools/writeBankImport.ts :: NO_LOCK',
      'src/lib/mcp/tools/writeBankImport.ts :: { lock: false }',
    ]);
  });
});
