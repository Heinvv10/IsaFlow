/**
 * WHERE THE MODEL BREAKS TEXT IS WHERE CHROMIUM BREAKS IT.
 *
 * `packLineBreaks.pieces` splits at spaces, after hyphens, around dashes, and between grapheme clusters that
 * Chromium breaks between (`packBreakRanges.ts`). For each text, Chromium's min-content width is the widest of the
 * pieces the model breaks it into, each measured on its own; and the table of code points that break is re-derived
 * from production's image and compared with the committed one (`printParity/packBreakTablesImage.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { measure, openProbePage } from './measureWidths';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const TEXTS = [
  // The breaks the pair table holds (`packBreakPairs.ts`), among them the acute accent's (#1235 round 3), and the break
  // after the space separators the faces lack (round 4). A word-opening en dash breaks in this Chromium and not in
  // production's (`fixtures/breakPairsCensus.asProduction`): the table test has it.
  'ab\u00B4cd', '12\u00B434', 'ab\u3000cd', 'ab\u205Fcd', 'ab\u1680cd', '\u2026Telecommunications', 'Pty.-Ltd', 'Equipment (net)-Cape Town', 'VAT 15%-inclusive', 'ab\u2013\u2013cd',
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

/**
 * Every ordered pair of clusters from a mixed set (ideographs, kana, the iteration mark, full-width forms, emoji
 * sequences, Latin, Greek, Cyrillic, Hebrew, Thai, Devanagari, Arabic, currency and number signs, every kind of
 * punctuation and dash, the word joiner, the zero-width space, the no-break space), three times over between two letters:
 * the model never breaks a text into pieces narrower than Chromium's narrowest width (the adversary's round-3 probe).
 */
const PAIR_CLUSTERS = ['日', '한', 'あ', 'ー', 'ぁ', '々', 'Ａ', '１', '😀', '❤️', '✅', '🇿🇦', '👍🏽', '👨‍👩‍👧', 'a', '5', 'é', 'α', 'Ж', 'א', 'ก', 'ह', 'ي',
  '€', '£', '¢', '°', '±', '‰', '−', '₹', '$', '%', '(', ')', '"', "'", '’', '.', ',', '!', '?', '/', '&', '+', '「', '」', '。', '、', '・', '…', '-', '–', '—', ' ',
  '\u2060', '\u200B', '\u00A0', '·', '#', '*', 'ﾊ', 'ｰ', '〜', '〃', '゛', '℃', '㎡', 'ℹ️', '1️⃣'];

/**
 * A piece's width on its line is its glyphs' advances AS SHAPED IN THE WHOLE TEXT (the last one carries its kerning
 * towards the next piece) or, where Chromium reshapes at the break, the piece shaped alone: the wider of the two.
 */
async function piecesInContext(texts: readonly string[]): Promise<Array<{ min: number; widest: number }>> {
  const page = await openProbePage(browser);
  try {
    return await page.evaluate((list) => {
      const td = document.getElementById('label')!;
      const span = (text: string, style: string): HTMLSpanElement => {
        const s = document.createElement('span');
        s.className = 'pack-kpi-unavailable';
        s.style.cssText = style;
        s.textContent = text;
        td.appendChild(document.createElement('div')).appendChild(s);
        return s;
      };
      return list.map(({ text, parts }) => {
        td.textContent = '';
        const min = span(text, 'display:inline-block;width:min-content;white-space:normal').getBoundingClientRect().width;
        const line = span(text, 'white-space:nowrap').firstChild!;
        let at = 0;
        const widest = Math.max(...parts.map((part) => {
          const from = text.indexOf(part, at);
          const range = document.createRange();
          range.setStart(line, from);
          range.setEnd(line, from + part.length);
          at = from + part.length;
          const alone = span(part, 'white-space:nowrap').getBoundingClientRect().width;
          return Math.max(alone, range.getBoundingClientRect().width);
        }));
        return { min, widest };
      });
    }, texts.map((text) => ({ text, parts: pieces(text).map((p) => p.text) })));
  } finally {
    await page.close();
  }
}

describe('every pair of clusters', () => {
  it('the model\'s widest piece is never narrower than Chromium\'s narrowest width', async () => {
    const texts = PAIR_CLUSTERS.flatMap((x) => PAIR_CLUSTERS.map((y) => `a${x}${y}${x}${y}${x}${y}a`));
    const res = await piecesInContext(texts);
    const unsafe = texts.flatMap((t, i) => (res[i]!.widest < res[i]!.min - 0.01
      ? [`${JSON.stringify(t)}: pieces ${JSON.stringify(pieces(t).map((p) => p.text))} ${res[i]!.widest}px, Chromium ${res[i]!.min}px`] : []));
    expect(unsafe.slice(0, 30)).toEqual([]);
  }, 600_000);
});

// The table of code points Chromium breaks between depends on the host's fallback fonts: it is held to production's
// image, velo only (`tests/unit/printParity/packBreakTablesImage.test.ts`).
