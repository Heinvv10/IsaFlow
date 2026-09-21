/**
 * Decides whether a dynamically-registered OAuth client may use a given
 * client_name.
 *
 * The name is rendered on the consent screen, where a user decides whether to
 * hand an app their books. Two reserved classes, with different rules, because
 * they carry different risk:
 *
 *  - Claiming to be official / verified / first-party is never legitimate, so
 *    those terms are refused wherever they appear.
 *  - The brand is legitimate as a QUALIFIER ("Claude Code (isaflow)") — naming
 *    the service you connect to is what a well-behaved MCP client does — and
 *    illegitimate as the SUBJECT ("IsaFlow", "IsaFlow Connector", "The IsaFlow
 *    App"), which reads as "this IS IsaFlow".
 *
 * Both checks run over a folded form, so a registrant cannot walk past them
 * with a zero-width space, a Cyrillic look-alike or a stray separator. Folding
 * is deliberately lossy and one-way: it exists only to compare a name against
 * the reserved terms, and never to derive what gets displayed or stored.
 */

/**
 * Latin look-alikes, folded onto one representative each. Ambiguity (both "l"
 * and "1" look like "i") is harmless because the reserved terms are folded
 * through the same table — the two sides always meet in the same place.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', ғ: 'f', һ: 'h', і: 'i', ј: 'j',
  к: 'k', ӏ: 'i', м: 'm', н: 'h', о: 'o', р: 'p', ԛ: 'q', ѕ: 's', т: 't',
  ѵ: 'v', ԝ: 'w', х: 'x', у: 'y',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p',
  τ: 't', υ: 'u', χ: 'x', γ: 'y',
  // Latin variants NFKC leaves alone
  ł: 'i', ſ: 's', ı: 'i',
  // letter/digit shapes
  l: 'i', '1': 'i', '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
};

/**
 * Stands in for exactly one character we could not identify — an unmapped
 * look-alike, or a symbol used as a letter. Never produced by the tokenizer;
 * only inserted at a token junction when testing a candidate run.
 */
const WILDCARD = '\u0000';

/**
 * Splits a name into comparison tokens. Accents are decomposed and dropped and
 * look-alikes folded onto one representative; everything that is not then an
 * ASCII alphanumeric is a separator. That covers zero-width and bidi-control
 * characters too — they separate nothing, because separators are dropped when
 * a run of tokens is joined back together.
 *
 * Lossy and one-way: used only to compare against reserved terms, never to
 * derive what is displayed or stored.
 *
 * Residual risk, stated rather than implied. This compares spellings of the
 * same length, so it stops SUBSTITUTION — one swapped glyph — and not
 * insertion or deletion: "IsaFllow", "IssaFlow" and "IsFlow" all register.
 * That is not a tuning gap. "IsaFllow" folds to "isafiiow" and "Lisa Flow"
 * folds to "iisafiow"; both are the brand plus one character, so no matcher
 * that works on spelling alone can refuse the first and allow the second.
 * Tolerating insertion means refusing ordinary names, and this dial is set to
 * allow them. Nor does it stop several substituted glyphs at once, or the
 * general n:1 shape ("rn" for "m").
 *
 * It is one control among several — every dynamically-registered client also
 * renders the unverified-app warning on the consent screen, which is what
 * carries the names this cannot catch.
 */
export function tokenizeForComparison(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/./gsu, (ch) => {
      const folded = CONFUSABLES[ch] ?? ch;
      return /[a-z0-9]/.test(folded) ? folded : ' ';
    })
    // One cheap multi-character look-alike, aimed at this brand's own letters.
    // The general n:1 class (rn for m, cl for d) is not covered — see the note
    // on residual risk in the module comment.
    .replace(/vv/g, 'w')
    .split(' ')
    .filter(Boolean);
}

/** True when `candidate` is `target`, with WILDCARD matching any one character. */
function matchesTerm(candidate: string, target: string): boolean {
  if (candidate.length !== target.length) return false;
  for (let i = 0; i < target.length; i += 1) {
    if (candidate[i] !== target[i] && candidate[i] !== WILDCARD) return false;
  }
  return true;
}

/**
 * True when a reserved term is spelled out by a whole run of adjacent tokens.
 *
 * Whole runs, not substrings: "Isa Flow" and "isa-flow" spell the brand across
 * two tokens and are refused, while "Lisa Flow" and "Unofficial Xero Sync" —
 * which merely contain those letters inside a longer word — are not.
 *
 * A separator is also tried as a single wildcard, because a symbol can stand in
 * for a letter it resembles ("!saflow", "is@flow"). Dropping it and standing it
 * in for one letter are both considered, so "Isa Flow!" stays refused on the
 * dropped reading while "!saflow" is caught on the other.
 */
function containsTerm(tokens: string[], target: string): boolean {
  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = start; end < tokens.length; end += 1) {
      const run = tokens.slice(start, end + 1);
      const joined = run.join('');
      if (joined.length > target.length) break;
      if (matchesTerm(joined, target)) return true;
      // ...or with one junction — including the edges — standing in for a letter.
      for (let gap = 0; gap <= run.length; gap += 1) {
        const withGap = [...run.slice(0, gap), WILDCARD, ...run.slice(gap)].join('');
        if (matchesTerm(withGap, target)) return true;
      }
    }
  }
  return false;
}

/** Refused wherever they appear — claiming these is never legitimate. */
const RESERVED_ADJECTIVES = ['official', 'verified', 'first party'].map((term) =>
  tokenizeForComparison(term).join(''),
);
const BRAND = tokenizeForComparison('isaflow').join('');

/** A trailing "(...)" qualifier, e.g. the "(isaflow)" in "Claude Code (isaflow)". */
const TRAILING_QUALIFIER_RE = /\s*\([^()]*\)$/;

/**
 * A qualifier qualifies something. A prefix has to name an actual client for
 * "<client> (isaflow)" to read as "<client>, which talks to IsaFlow" rather
 * than as the brand alone — so it needs at least two letters. One glyph, a
 * digit, a stray separator or an invisible character names nothing, and
 * "\u200b(IsaFlow)" renders as plain "(IsaFlow)".
 */
const MIN_QUALIFIED_PREFIX_LETTERS = 2;

/**
 * True when client_name impersonates IsaFlow or claims official standing, and
 * must therefore be refused.
 */
export function isReservedClientName(name: string): boolean {
  const tokens = tokenizeForComparison(name);
  if (RESERVED_ADJECTIVES.some((term) => containsTerm(tokens, term))) return true;

  const prefixTokens = tokenizeForComparison(name.replace(TRAILING_QUALIFIER_RE, ''));
  const letters = prefixTokens.join('').replace(/[^a-z]/g, '').length;
  const subject = letters >= MIN_QUALIFIED_PREFIX_LETTERS ? prefixTokens : tokens;
  return containsTerm(subject, BRAND);
}
