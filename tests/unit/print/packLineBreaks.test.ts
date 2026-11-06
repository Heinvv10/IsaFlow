/**
 * WHERE THE MODEL BREAKS TEXT IS WHERE CHROMIUM BREAKS IT.
 *
 * `packLineBreaks.pieces` splits at spaces, after hyphens, around dashes, and between grapheme clusters that
 * Chromium breaks between (`packBreakRanges.ts`). For each text, Chromium's min-content width is the widest of the
 * pieces the model breaks it into, each measured on its own; and the table of code points that break is re-derived
 * from Chromium and compared with the committed one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { SELF_BREAKING, breaksBetween } from '@/modules/accounting/services/packs/pages/packBreakRanges';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { measure } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const TEXTS = [
  '2024-25', 'abc-def', 'abc-5', 'abc/def', 'abc/5', '1/2', 'abc–def', '5–6', 'abc—def', '————', 'ab——cd',
  '-5', '-abc', '(abc-def)', 'abc--def', 'a-b-c', 'Fy2024/25', 'abc.def', 'abc,def', 'abc:def', 'R&D',
  '\u{1F600}\u{1F600}\u{1F600}\u{1F600}', '\u{1F44D}\u{1F3FD}\u{1F44D}\u{1F3FD}\u{1F44D}\u{1F3FD}', '\u{1F468}‍\u{1F469}‍\u{1F467}\u{1F468}‍\u{1F469}‍\u{1F467}\u{1F468}‍\u{1F469}‍\u{1F467}',
  '\u{1F1FF}\u{1F1E6}\u{1F1FF}\u{1F1E6}\u{1F1FF}\u{1F1E6}', '❤️❤️❤️', '✅✅✅✅',
  '日本語日本語', '한국어한국어', 'ＡＢＣＤＥ', '€€€€€', '°°°°', '±±±±',
  '∑∑∑∑∑', '★★★★', 'cafés ’x’ × y', 'ab 日本 cd \u{1F600}x',
  // No-break spaces hold a figure together; a vertical tab and a form feed are not breaks either.
  'R\u00A01\u00A0000', 'R\u202F1\u202F000', '1\u2007000', 'abc\uFEFFdef', 'abc\u000Bdef', 'abc\u000Cdef',
  // The other space separators break after a run of them, and the run stays on its line.
  'abcdef\u2003ghi', 'abc\u2003\u2003def', 'abc\u2009def\u2009gh', 'abc \u2003def', 'abc\u3000def', 'abcdef\u1680gh', 'abc\u2028def', 'abc\tdef\nghi',
];

// Thai, Lao, Khmer, Myanmar and the like break by dictionary, not by character: the model leaves them whole (a
// row may be refused that Chromium would fit, never the other way).
describe('the pieces of a text', () => {
  it.each(TEXTS)('%s: Chromium\'s narrowest width is the widest of the pieces the model breaks it into', async (text) => {
    const probes = [
      { probe: 'label' as const, text, html: `<span class="pack-kpi-unavailable" style="display:inline-block;width:min-content;white-space:normal">${text}</span>` },
      ...pieces(text).map((piece) => ({ probe: 'label' as const, text: piece.text, html: `<span class="pack-kpi-unavailable" style="white-space:nowrap">${piece.text}</span>` })),
    ];
    const res = await measure(browser, probes);
    expect(res[0]!.widthPx).toBeCloseTo(Math.max(...res.slice(1).map((r) => r.widthPx)), 0);
  });

  it('a ZWJ family, a skin-toned hand, a flag and a heart with its selector each stay one piece', () => {
    expect(pieces('\u{1F468}‍\u{1F469}‍\u{1F467}').map((p) => p.text)).toHaveLength(1);
    expect(pieces('\u{1F44D}\u{1F3FD}').map((p) => p.text)).toHaveLength(1);
    expect(pieces('\u{1F1FF}\u{1F1E6}').map((p) => p.text)).toHaveLength(1);
    expect(pieces('❤️').map((p) => p.text)).toHaveLength(1);
    expect(pieces('\u{1F600}\u{1F600}\u{1F600}')).toHaveLength(3);
  });
});

/**
 * The model's unit is the grapheme cluster Node's `Intl.Segmenter` returns; Chromium's line breaker has its own. Where
 * they disagree the model must take FEWER breaks than Chromium (a row refused that would have fitted), never more (a
 * row passed that overflows). Every kind of emoji sequence, alone and against each kind of neighbour.
 */
const SEQUENCES: Record<string, string> = {
  'ZWJ family': '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', 'ZWJ with a skin tone': '\u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}',
  'ZWJ couple, two tones': '\u{1F469}\u{1F3FE}\u200D\u{1F91D}\u200D\u{1F468}\u{1F3FB}', 'ZWJ with a selector': '\u{1F3F3}\uFE0F\u200D\u{1F308}',
  'ZWJ ending in an arrow (15.1)': '\u{1F642}\u200D\u2194\uFE0F', 'ZWJ (15.1)': '\u{1F426}\u200D\u{1F525}', 'ZWJ family (15.1)': '\u{1F9D1}\u200D\u{1F9D1}\u200D\u{1F9D2}',
  'a dangling joiner': '\u{1F600}\u200D', 'skin tone': '\u{1F44D}\u{1F3FD}', 'a lone skin tone': '\u{1F3FD}',
  flag: '\u{1F1FF}\u{1F1E6}', 'flag (16.0)': '\u{1F1E8}\u{1F1F6}', 'a lone regional indicator': '\u{1F1FF}',
  'tag flag': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  'keycap digit': '1\uFE0F\u20E3', 'keycap hash': '#\uFE0F\u20E3', 'keycap star': '*\uFE0F\u20E3',
  'VS16 on a text symbol': '\u263A\uFE0F', 'VS16 on a dingbat': '\u270C\uFE0F', 'VS15': '\u2764\uFE0E', 'VS16 on ©': '\u00A9\uFE0F',
  'emoji 16.0': '\u{1FAE9}', 'emoji 16.0 (fingerprint)': '\u{1FAC6}', 'emoji 16.0 (splatter)': '\u{1FADF}', 'emoji 17.0': '\u{1FAC8}', 'emoji 17.0 (trombone)': '\u{1FA8A}',
};
const CONTEXTS: ReadonlyArray<readonly [string, (s: string) => string]> = [
  ['three in a row', (s) => s.repeat(3)], ['between letters', (s) => `ab${s}cd`], ['before digits', (s) => `${s}12`],
  ['after digits', (s) => `12${s}`], ['between ideographs', (s) => `日${s}日`], ['between emoji', (s) => `\u{1F600}${s}\u{1F600}`],
  ['between currency signs', (s) => `€${s}€`], ['around a hyphen', (s) => `a-${s}-b`], ['in brackets', (s) => `(${s})`],
];

describe('grapheme clusters against Chromium\'s line breaker', () => {
  it('for every emoji sequence in every context, the model\'s widest piece is never narrower than Chromium\'s narrowest width', async () => {
    const cases = Object.entries(SEQUENCES).flatMap(([name, seq]) => CONTEXTS.map(([where, ctx]) => ({ name: `${name}, ${where}`, text: ctx(seq) })));
    const probes = cases.flatMap(({ text }) => [
      { probe: 'label' as const, text, html: `<span class="pack-kpi-unavailable" style="display:inline-block;width:min-content;white-space:normal">${text}</span>` },
      ...pieces(text).map((piece) => ({ probe: 'label' as const, text: piece.text, html: `<span class="pack-kpi-unavailable" style="white-space:nowrap">${piece.text}</span>` })),
    ]);
    const res = await measure(browser, probes);
    let at = 0;
    const short: string[] = [];
    for (const { name, text } of cases) {
      const chromium = res[at]!.widthPx;
      const n = pieces(text).length;
      const model = Math.max(...res.slice(at + 1, at + 1 + n).map((r) => r.widthPx));
      at += 1 + n;
      if (model < chromium - 0.01) short.push(`${name}: model ${model}px in ${n} pieces, Chromium ${chromium}px`);
    }
    expect(short).toEqual([]);
  }, 300_000);
});

describe('the table of code points Chromium breaks between', () => {
  // One layout per batch: every candidate's run of four is set twice (min-content and one line) and read after.
  it('re-scanned in Chromium, it is the committed table (U+00A0 to U+FFFF, U+10000 to U+1FFFF, U+20000 to U+323AF)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><head><style>body{font:14px sans-serif}.a{width:min-content;white-space:normal}.b{width:max-content;white-space:nowrap}</style></head><body><div id="host"></div></body></html>');
      const ranges: Array<[number, number]> = [[0xa0, 0xffff], [0x10000, 0x1ffff], [0x20000, 0x323af]];
      const scanned = await page.evaluate((rs) => {
        const skip = /[\p{M}\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Z}]|[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Balinese}\p{Script=Batak}\p{Script=Javanese}\p{Script=Sundanese}\p{Script=Cham}\p{Script=Tai_Le}\p{Script=New_Tai_Lue}\p{Script=Tai_Tham}\p{Script=Tai_Viet}]/u;
        const candidates: number[] = [];
        for (const [lo, hi] of rs) for (let cp = lo; cp <= hi; cp += 1) if (!skip.test(String.fromCodePoint(cp))) candidates.push(cp);
        const host = document.getElementById('host')!;
        const out: number[] = [];
        for (let i = 0; i < candidates.length; i += 8192) {
          const batch = candidates.slice(i, i + 8192);
          const pairs = batch.map((cp) => {
            const a = document.createElement('div');
            const b = document.createElement('div');
            a.className = 'a';
            b.className = 'b';
            a.textContent = String.fromCodePoint(cp).repeat(4);
            b.textContent = a.textContent;
            host.append(a, b);
            return [a, b] as const;
          });
          pairs.forEach(([a, b], j) => { if (a.getBoundingClientRect().width < b.getBoundingClientRect().width - 0.5) out.push(batch[j]!); });
          host.replaceChildren();
        }
        return out;
      }, ranges);
      const committed = [] as number[];
      for (const [lo, hi] of SELF_BREAKING) for (let cp = lo; cp <= hi; cp += 1) committed.push(cp);
      expect(scanned.length).toBe(committed.length);
      expect(scanned.filter((cp, i) => cp !== committed[i])).toEqual([]);
      expect(breaksBetween(0x65e5)).toBe(true);
      expect(breaksBetween(0x61)).toBe(false);
    } finally {
      await page.close();
    }
  }, 120_000);
});
