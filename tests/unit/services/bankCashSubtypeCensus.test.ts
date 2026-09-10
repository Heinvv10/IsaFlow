/**
 * The census, mechanised.
 *
 * Round 5 review, MEDIUM-1: the round-4 conversion was partial, and the sites
 * it missed printed money — the VAT201 base box, the cash-flow forecast's
 * opening cash, the AFS cash notes. Converting them is not enough on its own;
 * the next hand-written `IN ('bank', 'cash')` re-opens the same gap, and the
 * only thing that catches it is a check that reads the tree.
 *
 * THIS IS A LINT, NOT A BEHAVIOUR TEST, and it is labelled as one deliberately:
 * it proves nothing about what any report computes. The behavioural proof lives
 * in tests/integration/k091c-subtype-vocabulary-agreement.int.test.ts, which
 * seeds one account per spelling and asserts that six surfaces agree. This file
 * only stops a NEW literal from being written beside them.
 *
 * There is no allow-list, because the patterns match a COMPARISON only. The
 * literals that are correct where they stand do not match them and need no
 * exemption: an importer WRITING the canonical `'bank'`, `getSystemAccount('bank')`
 * where "bank" is a system-account ROLE rather than a subtype, and the alias
 * table in `accountSubtypes.ts` that defines the vocabulary. The full
 * disposition, converted and deliberately-left alike, is tabled in
 * docs/audits/remediation/K-091/fix.md.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** `account_subtype`/`accountSubtype` compared against a bank or cash literal. */
const PATTERNS = [
  // SQL: = 'bank' | IN ('bank', ...) | <> 'cash' | ANY(ARRAY['bank'...])
  String.raw`account_subtype[^\n]{0,80}?(=|<>|!=|\bIN\b|\bALL\b|\bANY\b)[^\n]{0,40}?'(bank|cash|petty_cash|bank_account|cash_on_hand)'`,
  // TypeScript: accountSubtype === 'bank' | !== 'bank' | subtype === 'cash'
  String.raw`(accountSubtype|account_subtype|\bsubtype)\s*(===|!==)\s*'(bank|cash|petty_cash|bank_account|cash_on_hand)'`,
  // A named constant standing in for the literal.
  String.raw`^\s*const\s+\w*BANK_SUBTYPE\w*\s*=\s*'bank'`,
];

function grep(pattern: string): string[] {
  try {
    return execFileSync(
      'git',
      ['grep', '-nIE', pattern, '--', 'src/**/*.ts', 'src/**/*.tsx', 'pages/**/*.ts', 'pages/**/*.tsx'],
      { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').filter(Boolean);
  } catch {
    // git grep exits 1 with no matches, which is the passing case.
    return [];
  }
}

describe('bank/cash subtype census', () => {
  it('has no un-dispositioned literal subtype comparison left in src or pages', () => {
    const offenders = PATTERNS.flatMap(grep)
      // A comment explaining the history is not a comparison.
      .filter((line) => !/:\d+:\s*(\/\/|\/\*|\*|--)/.test(line));

    expect(offenders).toEqual([]);
  });

});
