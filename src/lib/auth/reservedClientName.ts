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
 * same length, so it stops SUBSTITUTION — one swapped glyph — and not an
 * INTERIOR insertion or deletion: "IsaFllow", "IssaFlow" and "IsFlow" all
 * register. An edit at either end leaves the brand intact as a window inside
 * the token, so "IIsaFlow" and "IsaFloww" are caught.
 * That is not a tuning gap. "IsaFllow" folds to "isafiiow" and "Lisa Flow"
 * folds to "iisafiow"; both are the brand plus one character, so no matcher
 * that works on spelling alone can refuse the first and allow the second.
 * Tolerating insertion means refusing ordinary names, and this dial is set to
 * allow them. Nor does it stop several substituted glyphs at once, or the
 * general n:1 shape ("rn" for "m"). Nor an adjective sheltered behind a
 * negation it does not mean ("UnUnofficial").
 *
 * It is one control among several — every dynamically-registered client also
 * renders the unverified-app warning on the consent screen, which is what
 * carries the names this cannot catch.
 */
export function tokenizeForComparison(value: string): string[] {
  const decomposed = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFKC');
  // A letter or digit we cannot identify stays INSIDE the token as a wildcard.
  // Treating it as a separator would split the word, and a welded affix then
  // pushes the run past the length bound and strands it: "TheIsafl<Armenian
  // o>w" reads as the brand but escaped that way.
  return foldAndSplit(decomposed, WILDCARD);
}

/**
 * Lowercase, fold look-alikes, and split into tokens. `unidentified` is what a
 * letter or digit we cannot map becomes. Shared by both passes so that a word
 * written in plain letters produces the identical token in each.
 */
function foldAndSplit(normalized: string, unidentified: string): string[] {
  return (
    normalized
      .toLowerCase()
      .replace(/./gsu, (ch) => {
        const folded = CONFUSABLES[ch] ?? ch;
        if (/[a-z0-9]/.test(folded)) return folded;
        return /\p{L}|\p{N}/u.test(folded) ? unidentified : ' ';
      })
      // One cheap multi-character look-alike, aimed at this brand's own letters.
      // The general n:1 class (rn for m, cl for d) is not covered — see the note
      // on residual risk in the module comment.
      .replace(/vv/g, 'w')
      .split(' ')
      .filter(Boolean)
  );
}

/**
 * At most one character of a reserved term may go unidentified. One swapped
 * glyph is the cheap legible attack; allowing more would refuse ordinary words
 * in scripts we do not map, since every one of their letters is a wildcard.
 */
const MAX_WILDCARDS = 1;

/** True when `candidate` is `target`, with WILDCARD matching any one character. */
function matchesTerm(candidate: string, target: string): boolean {
  if (candidate.length !== target.length) return false;
  let wildcards = 0;
  for (let i = 0; i < target.length; i += 1) {
    if (candidate[i] === target[i]) continue;
    if (candidate[i] !== WILDCARD) return false;
    wildcards += 1;
    if (wildcards > MAX_WILDCARDS) return false;
  }
  return true;
}

/**
 * Morphemes that turn a claim into its denial. "Unofficial Xero Sync" and
 * "Unverified Test Client" disclaim exactly what the adjective rule polices, so
 * a term directly behind one of these is not a claim at all.
 */
const NEGATIONS = ['un', 'non', 'not'];

/**
 * Which tokens have a plain twin: the same token produced WITHOUT compatibility
 * folding. NFKD turns superscript and subscript letters into ordinary ones, so
 * "\u1D58\u207FOfficial" tokenizes as "unofficial" while rendering to a user
 * as "Official" with a smudge in front. Its plain twin does not exist, because
 * without NFKD those superscripts are not letters at all.
 *
 * Matched one-for-one. A single plainly-written "Unofficial" confirms one token
 * and cannot vouch for a second, disguised one elsewhere in the same name —
 * "Unofficial \u1D58\u207FOfficial" would otherwise borrow the shelter.
 */
function plainTwins(tokens: string[], name: string): boolean[] {
  const pool = new Map<string, number>();
  for (const word of foldAndSplit(name.normalize('NFC'), ' ')) {
    pool.set(word, (pool.get(word) ?? 0) + 1);
  }
  return tokens.map((token) => {
    const left = pool.get(token) ?? 0;
    if (left === 0) return false;
    pool.set(token, left - 1);
    return true;
  });
}

/**
 * True when the term at `offset` is denied rather than claimed: the token
 * starts with a negating morpheme and the term follows it directly. The
 * negation must BE the start of the token, not merely precede the term —
 * otherwise any word ending in "un", "non" or "not" shelters it, and
 * "CanonOfficial", "SunOfficial", "KnotVerified" all read as claims.
 */
function isNegated(token: string, offset: number): boolean {
  return NEGATIONS.some((neg) => offset === neg.length && token.startsWith(neg));
}

/**
 * True when `token` spells `target` somewhere inside it.
 *
 * `plainTwin` is null for the brand, which has no negation reading. For an
 * adjective it says whether this token was written in plain letters — the
 * shelter is a privilege, so it is only granted to a negation a reader sees.
 * Claims are detected generously; shelters are granted strictly. Both classes are
 * matched anywhere in a token, because restricting either to the start leaves a
 * one-keystroke bypass: "OfficialIsaFlow" for the brand, "ClaudeCodeOfficial"
 * for the adjectives. The difference is that a negated adjective is not a
 * claim, while the brand is a coined word with no such reading — finding it
 * anywhere inside a token means the name trades on it.
 */
function tokenSpells(token: string, target: string, plainTwin: boolean | null): boolean {
  const last = token.length - target.length;
  for (let offset = 0; offset <= last; offset += 1) {
    if (plainTwin && isNegated(token, offset)) continue;
    if (matchesTerm(token.slice(offset, offset + target.length), target)) return true;
  }
  return false;
}

/**
 * True when a reserved term is spelled either inside one token or by a whole
 * run of adjacent tokens.
 *
 * Both are needed, and neither alone is enough. Whole runs catch a term broken
 * up by separators — "Isa Flow", "isa-flow" — while leaving "Lisa Flow" alone,
 * because no run of its tokens is the brand. Within one token catches the same
 * term welded together — "OfficialIsaFlow" is "Official IsaFlow" with one space
 * removed, and defeated both rules at once before this was added.
 *
 * A separator inside a run is also tried as a single wildcard, because a symbol
 * can stand in for a letter it resembles ("!saflow", "is@flow").
 */
function containsTerm(tokens: string[], target: string, twins: boolean[] | null): boolean {
  if (tokens.some((token, i) => tokenSpells(token, target, twins ? (twins[i] ?? false) : null))) return true;

  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = start; end < tokens.length; end += 1) {
      const run = tokens.slice(start, end + 1);
      const joined = run.join('');
      if (joined.length > target.length) break;
      if (matchesTerm(joined, target)) return true;
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
  const twins = plainTwins(tokens, name);
  if (RESERVED_ADJECTIVES.some((term) => containsTerm(tokens, term, twins))) return true;

  const prefixTokens = tokenizeForComparison(name.replace(TRAILING_QUALIFIER_RE, ''));
  const letters = prefixTokens.join('').replace(/[^a-z]/g, '').length;
  const subject = letters >= MIN_QUALIFIED_PREFIX_LETTERS ? prefixTokens : tokens;
  return containsTerm(subject, BRAND, null);
}
