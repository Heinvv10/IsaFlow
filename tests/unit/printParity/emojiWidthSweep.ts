/**
 * THE ROUND-7 SWEEP'S STRINGS (#1264): every Extended_Pictographic code point (2,848) in fourteen emoji-sequence forms, bare
 * and among letters, and a seeded fuzz of 1 to 7 code points drawn from pictographs, digits, letters, ZWJ, selectors,
 * skin tones, keycap marks, tags and regional indicators. `packProseMarksR7Image.test.ts` sets each in production's image
 * and holds the page model's and the gate's width to its width.
 */
const S = (...cps: number[]): string => String.fromCodePoint(...cps);
const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const TONE = 0x1f3fd;

/** Every Extended_Pictographic code point. */
export function pictographs(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) if (!(cp >= 0xd800 && cp <= 0xdfff) && /^\p{Extended_Pictographic}$/u.test(S(cp))) out.push(cp);
  return out;
}

const FORMS: ReadonlyArray<(c: number) => string> = [
  (c) => S(c, VS15), (c) => S(c, VS16), (c) => S(c, VS16, TONE), (c) => S(c, TONE), (c) => S(c, ZWJ, 0x31), (c) => S(0x31, ZWJ, c),
  (c) => S(c, ZWJ, 0x2640, VS16), (c) => S(c, TONE, ZWJ, 0x2640, VS16), (c) => S(c, TONE, ZWJ, c), (c) => S(c, ZWJ, c),
  (c) => S(c, VS16, ZWJ, c, VS16), (c) => S(TONE, ZWJ, c, TONE), (c) => S(c, 0xfe00), (c) => S(c, 0xe0100),
];

/** The pictograph sweep: each pictograph in each form, bare and as "ab" + form + "b". */
export function pictographSweep(): string[] {
  const eps = pictographs();
  return FORMS.flatMap((form) => eps.flatMap((c) => [form(c), `ab${form(c)}b`]));
}

/** `count` seeded random strings of the emoji classes. */
export function emojiFuzz(seed: number, count: number): string[] {
  let state = seed;
  const rnd = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const eps = pictographs();
  const common = [0x1f600, 0x2764, 0x1f468, 0x1f469, 0x1f466, 0x1f3f3, 0x1f308, 0x2640, 0x2642, 0x2695, 0xa9, 0xae, 0x2122, 0x1f441, 0x1f525, 0x1f634, 0x1f6fb, 0x26a0, 0x2b50];
  const digits = [...'0123456789#*'].map((c) => c.codePointAt(0)!);
  const letters = [0x61, 0x5a, 0xe4, 0x44f, 0x3b1, 0x4e2d, 0xac00, 0x628, 0x5d0, 0x915, 0xe01, 0x3042, 0x30a2, 0x20, 0x2e, 0x2d, 0x2044, 0xb7, 0x25, 0x40];
  const selectors = [0xfe0f, 0xfe0f, 0xfe0e, 0xfe00, 0xfe01, 0xfe0d, 0xe0100, 0xe01ef];
  const tones = [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff];
  const misc = [0x20e3, 0x20e3, 0xe0020, 0xe0067, 0xe007f, 0x1f1e6, 0x1f1ff, 0x301, 0x93c, 0x200c, 0xad, 0x200b, 0x2060, 0x2640, 0x2642, 0x2695];
  const one = (): number => {
    const r = rnd();
    if (r < 0.2) return pick(eps);
    if (r < 0.32) return pick(common);
    if (r < 0.42) return pick(digits);
    if (r < 0.52) return pick(letters);
    if (r < 0.68) return ZWJ;
    if (r < 0.76) return pick(selectors);
    if (r < 0.86) return pick(tones);
    return pick(misc);
  };
  return Array.from({ length: count }, () => {
    const text = S(...Array.from({ length: 1 + Math.floor(rnd() * 7) }, one));
    return rnd() < 0.5 ? text : `ab${text}b`;
  });
}

/**
 * A mark after a character the ruler deletes (a soft hyphen, a zero-width space, a bidi isolate), after text of every
 * shape the gap offset counts: nothing, a letter, an astral character, a letter with marks, a joined sequence (blind
 * M1: the offset counts code points, which only a character beyond the BMP or a cluster of several shows).
 */
export function gapTexts(): string[] {
  const before = ['', 'a ', '\u{1F600} ', '\u{1D49C} ', 'e\u0301 ', 'a\u0301\u0323 ', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} ', '\u{1F1E6}\u{1F1E7} ', '1\uFE0F\u20E3 '];
  const marked = ['\u092F\u00AD\u093C', '\u1780\u200B\u17B6', '\u0995\u2066\u09BC', '\u07DB\u00AD\u07EB', '\u092F\u2060\u093C'];
  return before.flatMap((b) => marked.flatMap((m) => [`${b}${m}`, `${b}${m} ${b}${m}`]));
}
