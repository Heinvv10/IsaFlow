/**
 * Which files decide a VAT claim, and which of those go through a guard.
 *
 * WHY THIS GATE EXISTS. Four separate code paths posted a VAT claim nobody
 * reviewed, and each was found by a different accident: the bank-rule sweep by
 * writing the feature, the confidence gate by a blind reviewer, the provisional
 * import poster by chasing a question put to that reviewer, and the MCP bulk
 * allocation tool — which had posted ALL 35 of the non-supply VAT lines in
 * production — by finally asking the ledger `posting_agent` instead of
 * assuming. Four discoveries, four different routes, none of them systematic.
 *
 * The search that would have found all four at once is the one below: a file
 * that computes or forwards a VAT claim must go through
 * `gl/ruleVatResolution` (or the denial funnel it wraps), or be listed as an
 * ATTENDED path with a reason. This turns "a reviewer notices the next one"
 * into a build failure.
 *
 * IMPORTS, NOT MENTIONS. A file satisfies the gate by IMPORTING a guard, never
 * by naming one in a comment — `bankAllocationService` has the funnel all over
 * its prose explaining why it deliberately does not call it, and a substring
 * check would read that as compliance. That is the source-text-assertion trap
 * this repo has been bitten by before.
 */

/**
 * Named VAT machinery. A bare `0.15` is deliberately NOT matched — no regex
 * distinguishes it from any other fraction, and pretending otherwise would
 * make this gate look stronger than it is. What IS caught is a file that tags
 * a journal line with a VAT type and posts, which is the shape that matters.
 */
const RATE_CONSTANTS = /\b\w*VAT_(RATE|PCT)\w*\b/;

/**
 * A VAT type reaching a journal line, in ANY of the forms people write it.
 *
 * The first cut matched only `vatType: 'standard'` — an object-literal colon
 * with single quotes. `line.vatType = code` sailed through, and so did double
 * quotes, and neither is evasion: building a line incrementally is completely
 * ordinary code. So this matches the FIELD, in a colon or an assignment,
 * whatever is on the right of it.
 */
const VAT_FIELD = /\b(vatType|vat_type)\s*[:=]/;

/**
 * The functions that get a line into the ledger. `vat_type` alone is not a
 * defect — reports read it constantly — so the field only puts a file in scope
 * when the file also posts.
 */
const POSTING_FNS = ['createJournalEntry', 'postJournalEntry', 'allocateTransaction'];

/** A raw write, which no import alias can disguise. */
const RAW_INSERT = /INSERT\s+INTO\s+gl_journal_lines/i;

/**
 * Does this file call a posting function, under ANY name it imported it as?
 *
 * Matching the canonical names alone left the same alias hole this file had
 * closed on the guard side: `import { createJournalEntry as post }` and the
 * call site says `post(`, so the file went not merely unguarded but INVISIBLE
 * — no finding, no allowlist entry, silently skipped. Aliasing an import is
 * ordinary TypeScript, not evasion.
 *
 * KNOWN LIMITS, stated rather than chased with a bigger regex — a text scanner
 * cannot resolve a binding graph, and pretending it can is worse than saying
 * where it stops:
 *
 *   - A computed property key (`line[FIELD_MAP.vat] = code`) never puts
 *     `vatType` next to a `:` or `=`, so a generic field-mapper slips past
 *     VAT_FIELD. That shape is exactly what bulk-import code looks like.
 *   - A RE-EXPORT FACADE hides the canonical name from the consumer:
 *     `export { createJournalEntry as post } from '...'` in one file, then
 *     `import { post } from './facade'` in another. The facade itself is
 *     caught; the consumer is not.
 *   - A DEFAULT import carries no name to match. Not a live risk here — the
 *     posting services all use named exports — but it is a hole.
 *
 * Following a binding through an arbitrary chain of reassignment and re-export
 * is an AST/type-checker job, not a regex one. This gate narrows the ways a
 * poster hides; it does not eliminate them.
 */
export function callsAPostingFunction(strippedSource: string): boolean {
  if (RAW_INSERT.test(strippedSource)) return true;
  const names = new Set(POSTING_FNS);
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"][^'"]*['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(strippedSource)) !== null) {
    for (const spec of m[1]!.split(',')) {
      const [imported, alias] = spec.split(/\sas\s/).map((x) => x.trim());
      if (imported && POSTING_FNS.includes(imported) && alias) names.add(alias);
    }
  }
  // A REFERENCE, not a call. `const doPost = journalService.createJournalEntry`
  // and `const post = _cje` both put the function in a local const with no `(`
  // after the name, and both are ordinary style — a namespace import for a
  // service with many exports, and grabbing the one function you need. Matching
  // the bare name catches the mention in the namespace access and in the import
  // statement itself, which is what those two variants cannot avoid having.
  return [...names].some((n) => new RegExp(`\\b${n}\\b`).test(strippedSource));
}

/** Handing a vat code to the poster that deliberately enforces nothing. */
const ALLOCATE_CALL = /\ballocateTransaction\s*\(/;

export type VatDecisionKind = 'rate_constant' | 'vat_field_on_a_posting_path' | 'allocate_call';

export interface VatGuardFinding {
  /** Why the file is in scope. */
  kinds: VatDecisionKind[];
  /** True when it imports one of the guard modules. */
  guarded: boolean;
}

/** Does this source decide or forward a VAT claim, and does it guard? */
export function inspectVatGuardCoverage(source: string): VatGuardFinding | null {
  const code = stripComments(source);
  const kinds: VatDecisionKind[] = [];
  if (RATE_CONSTANTS.test(code)) kinds.push('rate_constant');
  if (VAT_FIELD.test(code) && callsAPostingFunction(code)) kinds.push('vat_field_on_a_posting_path');
  if (ALLOCATE_CALL.test(code)) kinds.push('allocate_call');
  if (kinds.length === 0) return null;
  return { kinds, guarded: importsAndUsesGuard(code) };
}

/**
 * Does this file import a guard AND use what it imported?
 *
 * Both halves are load-bearing, and each was a hole in the first cut:
 *
 *   - Run on STRIPPED code, so an import-shaped line inside a block comment no
 *     longer counts. The original anchored on `^\s*import` against the RAW
 *     source, which rules out a `//` prefix but not a `/* ... *\/` wrapper.
 *   - Require a BINDING to appear again outside its own import statement.
 *     Importing `resolveRuleVatCode` and never calling it satisfied the old
 *     check: "imports, not mentions" was enforced, "imports, not ignores" was
 *     not.
 */
export function importsAndUsesGuard(strippedSource: string): boolean {
  const re =
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"][^'"]*(?:ruleVatResolution|inputVatDenial|allocationVatGuard)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(strippedSource)) !== null) {
    const bindings = match[1]!
      .split(',')
      .map((b) => (b.split(/\sas\s/).pop() ?? '').trim())
      .filter(Boolean);
    const rest = strippedSource.slice(0, match.index)
      + strippedSource.slice(match.index + match[0].length);
    if (bindings.some((b) => new RegExp(`\\b${b}\\b`).test(rest))) return true;
  }
  return false;
}

/**
 * Comments are stripped before looking for the DECISION, so a file explaining
 * the rule is not accused of breaking it — the same reason the guard check
 * reads imports. Imports are matched against the ORIGINAL source, because a
 * naive strip can eat a string containing `//` and take an import with it.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
