/**
 * RANDOM TEXTS BUILT TO FIND STATE EFFECTS (#1264 round 9): production draws a mark or symbol the primary face lacks in a
 * fallback face, and later symbols in that face too, wider than the model prices them alone. Each text is a random prefix
 * of 1 to 3 fallback characters (a mark on a base, an odd symbol, a letter of a script the faces lack, an emoji part), a
 * separator (space, line break, paragraph break), then a random suffix of symbols, digits and letters, sometimes a second
 * fallback character among them. Seeded, so a failing text is reproducible.
 */
const S = String.fromCodePoint;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** Marks the primary face lacks, and odd symbols and letters that production sets in a fallback face. */
const MARKS = [...range(0x20d0, 0x20f0), ...range(0x302a, 0x302f), 0x3099, 0x309a, ...range(0x64b, 0x652), 0x670, ...range(0x951, 0x954), ...range(0x1ac1, 0x1ace), ...range(0x1cd0, 0x1cd2),
  0x1dfa, ...range(0x890, 0x89f), ...range(0x8ca, 0x8d2), 0x13430, 0x1cf00, 0x93c, 0x94d, 0x200c, 0x200d, 0xfe0e, 0xfe0f, 0x483, 0x5b0, 0x1b44, 0x17d2];
const ODD = [0x2313, 0x2336, 0x2b1d, 0x10141, 0x1d2e0, 0x1f5a5, ...range(0x1f7e0, 0x1f7e8), ...range(0x1fb00, 0x1fb08), 0x23d0, 0x2999, 0x2af6, 0x22c5, 0x25dc, 0x266e, 0x275b, 0x27e8, 0x2982, 0x2b7b, 0x1d5c2];
const SCRIPT = [...range(0x1780, 0x17a2), ...range(0x1000, 0x1021), ...range(0xe01, 0xe2e), ...range(0x628, 0x64a), ...range(0x5d0, 0x5ea), ...range(0x915, 0x939), ...range(0xac00, 0xac40), ...range(0x4e00, 0x4e40),
  ...range(0x3042, 0x3060), ...range(0x1f600, 0x1f620), 0x1f3fb, 0x1f1ff, 0x1f1e6, 0x2764, 0x20e3, 0xe0067];
const SYMBOLS = [...range(0x2190, 0x21ff), ...range(0x2200, 0x22ff), ...range(0x2300, 0x23ff), ...range(0x25a0, 0x25ff), ...range(0x2600, 0x26ff), ...range(0x2700, 0x27bf), ...range(0x27c0, 0x27ef),
  ...range(0x2900, 0x29ff), ...range(0x2a00, 0x2aff), ...range(0x2b00, 0x2bff), 0x1d5c2, 0x1d7d8, 0xa9, 0xae, 0x2122, 0xb1, 0xd7, 0xf7, 0x20ac, 0xa3, 0x2022, 0x2026, 0x2013];
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#*.,;:()%/-'.split('');
const SEPARATORS = [' ', ' ', ' ', '\n', '\n\n', ' \n '];

/** `count` texts from `seed`, each of 120 to 900 characters: a prefix, then runs of one symbol (the state effect needs a later symbol repeated). */
export function randomStateTexts(seed: number, count: number): string[] {
  const next = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const fallback = (): string => {
    const r = next();
    if (r < 0.4) return S(pick(LETTERS).codePointAt(0)!, pick(MARKS));
    if (r < 0.55) return S(pick(MARKS));
    if (r < 0.8) return S(pick(ODD));
    return S(pick(SCRIPT), ...(next() < 0.3 ? [pick(MARKS)] : []));
  };
  const word = (): string => Array.from({ length: 1 + Math.floor(next() * 8) }, () => pick(LETTERS)).join('');
  return Array.from({ length: count }, () => {
    const lead = next() < 0.3 ? `${Array.from({ length: 1 + Math.floor(next() * 12) }, word).join(' ')} ` : '';
    const prefix = Array.from({ length: 1 + Math.floor(next() * 3) }, fallback).join(next() < 0.5 ? ' ' : '');
    const target = 120 + Math.floor(next() * 780);
    let body = '';
    while (body.length < target) {
      const r = next();
      if (r < 0.7) { const probe = S(pick(SYMBOLS)); body += `${probe}${next() < 0.85 ? ' ' : ''}`.repeat(10 + Math.floor(next() * 120)); }
      else if (r < 0.9) body += `${word()} `;
      else body += `${fallback()} `;
      if (next() < 0.05) body += pick(SEPARATORS);
    }
    return `${lead}${prefix}${pick(SEPARATORS)}${body}`.trim();
  });
}
