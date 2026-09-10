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
 * included), and runs THREE passes. The vocabulary all three read is derived
 * from `accountSubtypes` itself, so adding an alias there automatically widens
 * what they refuse.
 *
 *   1. PARTIAL LITERAL — a subtype compared against a raw spelling whose
 *      canonical token has more than one spelling.
 *   2. NEAR MISS — a subtype compared against a literal that is NOT in the
 *      vocabulary but CONTAINS a multi-word canonical token that is
 *      (`income_tax_expense` names `tax_expense`). Round 7's AFS note 20
 *      defect was exactly this: a hand-list DISJOINT from the vocabulary
 *      passed pass 1 silently while naming a concept the vocabulary owns.
 *   3. PARTIAL NAMED SET — a constant whose name ends in SUBTYPE/SUBTYPES and
 *      whose initialiser is a literal (or array of literals) that is a partial
 *      vocabulary set, wherever it appears and however it is later used.
 *
 * WHAT THESE PASSES DO NOT PROVE (round 7, MEDIUM-3 — the docstring used to
 * claim more than the mechanism delivers):
 *   · pass 1 searches FORWARD from the mention for an operator, so a reversed
 *     operand (`'bank' = ga.account_subtype`) and a `LIKE` are invisible;
 *   · a literal reached through a differently-named local, `[...].includes(x)`
 *     or a `switch` is invisible to all three unless the identifier holding it
 *     is named *SUBTYPE(S) — which is what pass 3 exists to cover;
 *   · pass 2's substring rule is restricted to MULTI-WORD tokens, or `bank`
 *     would match `bank_loan` and `tax` would match every tax-ish token in the
 *     AFS notes. `vat_payable` therefore does not flag against `payable`.
 * The behavioural reconciliation in tests/integration/k091d covers by OUTCOME
 * what these passes cannot reach by shape.
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
  canonicalSubtype,
  rawSubtypesFor,
} from '@/modules/accounting/services/gl/accountSubtypes';

const ROOT = resolve(__dirname, '../../..');

/** Multi-word tokens with more than one spelling — pass 2's near-miss stems. */
const MULTIWORD_TOKENS = ALL_CANONICAL_SUBTYPES.filter(
  (c) => c.includes('_') && rawSubtypesFor(c).length > 1,
);

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
  { file: 'src/modules/accounting/services/reports/vatBoxBasis.ts', literals: ['tax'], reason: 'raw VAT-control token, not the tax_expense concept' },
  // Asks whether the subtype is a PLACEHOLDER the importer left behind, not
  // which concept it names. Canonicalising would defeat the question.
  { file: 'src/modules/accounting/services/reports/classificationCoverageService.ts', literals: ['default_expense', 'default_revenue'], reason: 'placeholder detection, not classification' },
  // Note 17 splits income tax into current and deferred. Both canonicalise to
  // `tax_expense`; the split is a raw one INSIDE one token, and note 17's total
  // is the whole token, so it agrees with the income statement.
  { file: 'src/modules/accounting/services/afs/noteGenerators/notes16to20.ts', literals: ['deferred_tax_expense'], reason: 'current/deferred split inside one canonical token' },
  // The raw token a VAT control account carries. Canonicalising it would pull
  // income tax expense onto the balance-sheet exception list.
  { file: 'src/modules/accounting/services/reports/vatBalanceSheetExceptions.ts', literals: ['tax'], reason: 'raw VAT-control token, not the tax_expense concept' },
  // OPEN, deliberately deferred — K-091 round 7 MEDIUM-4. The fixed-asset
  // register's cost partition is mirrored between `fixedAssetReconciliationQueries`
  // (SQL), `fixedAssetReconciliationItems` (TypeScript) and this WRITE gate.
  // Widening one side alone IS the disagreement, so all three move together in
  // their own change, with a register-to-GL fixture.
  { file: 'src/modules/accounting/services/gl/leafAccountValidator.ts', literals: ['fixed_asset', 'fixed_assets'], reason: 'DEFERRED: two-way register partition, widens with its own fixture' },
  { file: 'src/modules/accounting/services/items/fixedAssetReconciliationQueries.ts', literals: ['*'], reason: 'DEFERRED: same partition as leafAccountValidator' },
  // The offerable-subtype UI enum and the system-account ROLE keys. These name
  // which subtype a NEW account is created with, not which existing accounts a
  // report reads, so one spelling per role is the point.
  { file: 'src/modules/accounting/types/glAccountSubtypes.ts', literals: ['*'], reason: 'write-side offerable subtypes and system-account roles' },
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
/** A constant NAMED as a subtype set: its initialiser must be a whole token. */
const NAMED_SET = /\b([A-Za-z_][A-Za-z0-9_]*(?:SUBTYPE|SUBTYPES|Subtype|Subtypes))\b\s*(?::[^=\n]*)?=\s*(\[[^\]]*\]|'[a-z_0-9]+')/g;

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
      const line = (index: number) => src.slice(0, index).split('\n').length;
      const exempted = (literal: string) => exempt.includes('*') || exempt.includes(literal);
      const flag = (literal: string, index: number) => {
        if (exempted(literal)) return;
        if (MULTI_SPELLING.has(literal)) {
          offenders.push(`${file}:${line(index)} compares a subtype against '${literal}'`);
          return;
        }
        if (canonicalSubtype(literal) !== null) return;
        const stem = MULTIWORD_TOKENS.find((t) => literal.includes(t));
        if (stem) offenders.push(`${file}:${line(index)} compares a subtype against '${literal}', which names '${stem}'`);
      };
      const flagNamed = (name: string, literal: string, index: number) => {
        offenders.push(`${file}:${line(index)} ${name} is a partial vocabulary set — '${literal}'`);
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

      NAMED_SET.lastIndex = 0;
      for (let n = NAMED_SET.exec(src); n !== null; n = NAMED_SET.exec(src)) {
        if (n[0].includes('CanonicalSubtype')) continue;
        const set = dropSharedVocabulary(n[2]!);
        for (const member of set.match(LITERAL) ?? []) {
          const literal = member.slice(1, -1);
          if (!MULTI_SPELLING.has(literal) || exempted(literal)) continue;
          if (rawSubtypesFor(canonicalSubtype(literal)!).every((sp) => n[2]!.includes(`'${sp}'`))) continue;
          flagNamed(n[1]!, literal, n.index);
        }
      }
    }

    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
