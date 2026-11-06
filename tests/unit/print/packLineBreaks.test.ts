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

describe('the table of code points Chromium breaks between', () => {
  it('re-scanned in Chromium, it is the committed table (U+00A0 to U+FFFF, U+10000 to U+1FFFF, U+20000 to U+323AF)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body style="font:14px sans-serif"><div id="a" style="display:inline-block;width:min-content;white-space:normal"></div><br><div id="b" style="display:inline-block;white-space:nowrap"></div></body></html>');
      const ranges: Array<[number, number]> = [[0xa0, 0xffff], [0x10000, 0x1ffff], [0x20000, 0x323af]];
      const scanned = await page.evaluate((rs) => {
        const a = document.getElementById('a')!;
        const b = document.getElementById('b')!;
        const out: number[] = [];
        for (const [lo, hi] of rs) {
          for (let cp = lo; cp <= hi; cp += 1) {
            if (cp >= 0xd800 && cp <= 0xdfff) continue;
            const ch = String.fromCodePoint(cp);
            if (/[\p{M}\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Z}]/u.test(ch) || /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Balinese}\p{Script=Batak}\p{Script=Javanese}\p{Script=Sundanese}\p{Script=Cham}\p{Script=Tai_Le}\p{Script=New_Tai_Lue}\p{Script=Tai_Tham}\p{Script=Tai_Viet}]/u.test(ch)) continue;
            a.textContent = ch.repeat(4);
            b.textContent = ch.repeat(4);
            if (a.getBoundingClientRect().width < b.getBoundingClientRect().width - 0.5) out.push(cp);
          }
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
  }, 600_000);
});
