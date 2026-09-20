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
 * Lossy one-way fold used only for reserved-term comparison. Decomposes and
 * drops accents, collapses look-alikes, then strips everything that is not an
 * ASCII alphanumeric — which is what removes separators AND every zero-width or
 * bidi-control character in one step. So "Isa Flow", "Isaflów",
 * "isa-flow", "ＩｓａＦｌｏｗ" and "isa​flow" all land on the same string
 * as "isaflow".
 */
export function foldForComparison(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/./gsu, (ch) => CONFUSABLES[ch] ?? ch)
    .replace(/[^a-z0-9]/g, '');
}

/** Refused wherever they appear — claiming these is never legitimate. */
const RESERVED_ADJECTIVES = ['official', 'verified', 'firstparty'].map(foldForComparison);
const BRAND = foldForComparison('isaflow');

/** A trailing "(...)" qualifier, e.g. the "(isaflow)" in "Claude Code (isaflow)". */
const TRAILING_QUALIFIER_RE = /\s*\([^()]*\)$/;

/**
 * A qualifier qualifies something. A prefix has to name an actual client for
 * "<client> (isaflow)" to read as "<client>, which talks to IsaFlow" rather
 * than as the brand alone — so it needs at least two letters. One glyph, a
 * digit, a stray separator or an invisible character names nothing, and
 * "​(IsaFlow)" renders as plain "(IsaFlow)".
 */
const MIN_QUALIFIED_PREFIX_LETTERS = 2;

function countLetters(folded: string): number {
  return folded.replace(/[^a-z]/g, '').length;
}

/**
 * True when client_name impersonates IsaFlow or claims official standing, and
 * must therefore be refused.
 */
export function isReservedClientName(name: string): boolean {
  const folded = foldForComparison(name);
  if (RESERVED_ADJECTIVES.some((term) => folded.includes(term))) return true;

  const foldedPrefix = foldForComparison(name.replace(TRAILING_QUALIFIER_RE, ''));
  const qualifies = countLetters(foldedPrefix) >= MIN_QUALIFIED_PREFIX_LETTERS;
  return (qualifies ? foldedPrefix : folded).includes(BRAND);
}
