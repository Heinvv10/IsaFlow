/**
 * The census, mechanised — and generalised after round 6.
 *
 * Rounds 4, 5 and 6 each converted the literals someone had thought to grep
 * for, and each left live read paths behind. Round 6's grep was bank/cash only,
 * `[^\n]`-bounded, and used a `pages/**` pathspec that git's wildmatch never
 * expands to a depth-1 file — so `afsKpiService`'s current ratio, the AR and AP
 * close gates and four AFS notes all sat outside it.
 *
 * So this no longer greps for a literal anyone chose. It enumerates the files
 * from `git ls-files`, reads each one WHOLE (multi-line `sql` templates
 * included), and flags any comparison of a subtype against a raw spelling whose
 * canonical token has MORE THAN ONE spelling — i.e. any literal that is
 * provably a partial set. The offending vocabulary is derived from
 * `accountSubtypes` itself, so adding an alias there automatically widens what
 * this refuses.
 *
 * THIS IS A LINT, NOT A BEHAVIOUR TEST. The behavioural proof lives in
 * tests/integration/k091c-subtype-vocabulary-agreement.int.test.ts, which seeds
 * one account per spelling and reconciles the surfaces that report it.
 *
 * ALLOWED lists the sites that are correct as literals, each with the reason
 * also tabled in docs/audits/remediation/K-091/fix.md. Nothing else is exempt.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_CANONICAL_SUBTYPES,
  rawSubtypesFor,
} from '@/modules/accounting/services/gl/accountSubtypes';

const ROOT = resolve(__dirname, '../../..');

/** Raw spellings whose canonical token has more than one — a literal is partial. */
const MULTI_SPELLING = new Set(
  ALL_CANONICAL_SUBTYPES.flatMap((c) => {
    const spellings = rawSubtypesFor(c);
    return spellings.length > 1 ? spellings : [];
  }),
);

/**
 * Sites where a raw spelling is the right thing to compare, keyed by path; the
 * listed literals are exempt in that file and nowhere else. Every entry here
 * suppresses a real hit — an entry that suppresses nothing is removed, so this
 * list cannot drift into a comfortable-looking fiction. The dispositions that
 * need no entry (write-side seeders, system-account ROLES, the fixed-asset
 * register's two-way partition, tokens outside the vocabulary) are tabled in
 * docs/audits/remediation/K-091/fix.md.
 */
const ALLOWED: ReadonlyArray<{ file: string; literals: readonly string[]; reason: string }> = [
  // `tax` here is the RAW token a VAT control account carries, deliberately
  // narrow. Canonicalising it would pull income tax into the VAT return — the
  // exact defect accountReportingClass records at R23,219.01 of PAYE.
  { file: 'src/modules/accounting/services/reports/vatBoxBasisQuery.ts', literals: ['tax'], reason: 'raw VAT-control token, not the tax_expense concept' },
  { file: 'src/modules/accounting/services/reports/vatReturnService.ts', literals: ['tax'], reason: 'raw VAT-control token, not the tax_expense concept' },
  // Asks whether the subtype is a PLACEHOLDER the importer left behind, not
  // which concept it names. Canonicalising would defeat the question.
  { file: 'src/modules/accounting/services/reports/classificationCoverageService.ts', literals: ['default_expense', 'default_revenue'], reason: 'placeholder detection, not classification' },
];

/** A subtype already put through the vocabulary is not a raw literal comparison. */
const CANONICALISED = /(?:canonicalSubtype|revenueBand|expenseBand|isBankSubtype|isCurrentSubtype|isCashEquivalent)\s*\(\s*[\w.]*$/;

/** Every tracked source file under src/ and pages/, depth-1 files included. */
function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f));
}

/** Blank out comments so an explanatory `= 'bank'` is not read as a comparison. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

const SUBTYPE = /(?:account_subtype|accountSubtype)/g;
/** The operator that follows the mention, and how far past a COALESCE wrap it may sit. */
const OPERATOR = /^[^\n]{0,30}?\s*(IS\s+(?:NOT\s+)?DISTINCT\s+FROM|<>|!==|!=|===|=|\bNOT\s+IN\b|\bIN\b)\s*/;
/** A local alias compared in TypeScript: `subtype === 'cash'`. */
const TS_ALIAS = /\b(?:subtype|accountSubtype|account_subtype)\s*(?:===|!==)\s*'([a-z_0-9]+)'/g;
const LITERAL = /'([a-z_0-9]+)'/g;

/** The right-hand operand: a balanced parenthesis group, or one literal. */
function operand(text: string): string {
  const head = /^(?:ANY|ALL)?\s*\(/.exec(text);
  if (!head) return /^'[a-z_0-9]+'/.exec(text)?.[0] ?? '';
  let depth = 0;
  for (let i = head[0].length - 1; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(head[0].length, i);
    }
  }
  return text.slice(head[0].length);
}

/** `rawSubtypesFor('x')` IS the shared vocabulary — its argument is not a literal comparison. */
function dropSharedVocabulary(text: string): string {
  return text.replace(/rawSubtypesFor\s*\([^)]*\)/g, '');
}

describe('subtype census', () => {
  it('compares no subtype against a literal that is only part of its vocabulary', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const exempt = ALLOWED.filter((a) => a.file === file).flatMap((a) => a.literals);
      const src = stripComments(readFileSync(resolve(ROOT, file), 'utf8'));
      const flag = (literal: string, index: number) => {
        if (!MULTI_SPELLING.has(literal)) return;
        if (exempt.includes('*') || exempt.includes(literal)) return;
        offenders.push(`${file}:${src.slice(0, index).split('\n').length} compares a subtype against '${literal}'`);
      };

      SUBTYPE.lastIndex = 0;
      for (let m = SUBTYPE.exec(src); m !== null; m = SUBTYPE.exec(src)) {
        if (CANONICALISED.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
        const rest = src.slice(m.index + m[0].length, m.index + 600);
        const op = OPERATOR.exec(rest);
        if (!op) continue;
        const rhs = dropSharedVocabulary(operand(rest.slice(op[0].length)));
        LITERAL.lastIndex = 0;
        for (let l = LITERAL.exec(rhs); l !== null; l = LITERAL.exec(rhs)) flag(l[1]!, m.index);
      }

      TS_ALIAS.lastIndex = 0;
      for (let t = TS_ALIAS.exec(src); t !== null; t = TS_ALIAS.exec(src)) flag(t[1]!, t.index);
    }

    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
