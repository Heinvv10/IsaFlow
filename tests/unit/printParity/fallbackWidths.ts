/**
 * THE FALLBACK GLYPH WIDTHS OF PRODUCTION'S RENDER HOST, MEASURED IN ITS OWN IMAGE: the generator of
 * `packFallbackWidthData.ts`.
 *
 * A glyph the pack's self-hosted faces lack is set in the render host's fallback fonts, so its width is a fact about
 * the production Gotenberg image, not about any test machine. Each code point from U+0020 to U+323AF is set between two
 * bars in each STYLE the fit model prices (a KPI tile's not-meaningful reason; a 9pt table label at 400, 500 and 600),
 * under the real print stylesheet, in a throwaway container of the image (`gotenbergParity.ts`); its advance is the
 * width less the two bars', rounded UP to a whole pixel. The page writes the advances into the PDF it prints, two
 * base-36 digits a code point, and `pdftotext` reads them back. Every emoji presentation (a VS16 sequence, a keycap) is
 * measured too, and the widest is the price of any. The FINGERPRINT is the exact width (in 1/64px) of a handful of
 * clusters across the fallback families, which the print page re-measures on the render host before it prints a pack
 * that uses a fallback glyph (`packFallbackGuard.ts`).
 */
import type { Gotenberg } from './gotenbergParity';
import { gotenbergPdf, withPdfFile } from './gotenbergParity';
import { execFileSync } from 'node:child_process';
import { inTableCell, parityDocument } from './parityPage';

export const FIRST = 0x20;
export const LAST = 0x323af;
const CHUNK = 8192;

export type FallbackStyle = 'reason' | 'label400' | 'label500' | 'label600';
export const STYLES: ReadonlyArray<readonly [FallbackStyle, string, string]> = [
  ['reason', '', 'pack-kpi-unavailable'], ['label400', 'font-weight:400', ''], ['label500', 'font-weight:500', ''], ['label600', 'font-weight:600', ''],
];

/** Clusters across the fallback families; their exact widths are the render host's fingerprint. */
export const FINGERPRINT_CLUSTERS = ['一', 'あ', '가', '\u{1F600}', 'ℹ️', '1️⃣', '\u{1F1FF}\u{1F1E6}', 'ب',
  'א', 'क', 'ก', 'Ա', 'ა', 'ሀ', '\u{1D400}', '★', '─', '⠁', '\u{20000}', 'ཀ', 'ក', '\u{1F468}‍\u{1F469}‍\u{1F467}'];

/** Every emoji presentation sequence: each emoji with VS16, and the twelve keycaps. */
export function emojiPresentations(): string[] {
  const out: string[] = [];
  for (let cp = 0x20; cp <= 0x1ffff; cp += 1) {
    const ch = String.fromCodePoint(cp);
    if (/\p{Emoji}/u.test(ch) && !/[0-9#*]/.test(ch)) out.push(`${ch}️`);
  }
  return [...out, ...'0123456789#*'.split('').map((c) => `${c}️⃣`)];
}

const SCRIPT = (groups: string): string => `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  var out = [];
  ${groups}.forEach(function (g) {
    var cell = document.querySelector('[data-parity="' + g + '"]');
    var spans = cell.querySelectorAll('span');
    var bars = spans[0].getBoundingClientRect().width;
    var digits = '';
    for (var i = 1; i < spans.length; i += 1) {
      var w = spans[i].getBoundingClientRect().width - bars;
      var x = g.indexOf(':x') > 0 ? Math.ceil(w * 64 - 0.001) : Math.max(0, Math.ceil(w - 0.001));
      var s = x.toString(36);
      digits += (g.indexOf(':x') > 0 ? '000' + s : '00' + s).slice(g.indexOf(':x') > 0 ? -3 : -2);
    }
    out.push('[' + g + '|' + digits + ']');
  });
  document.documentElement.className = '';
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  var pre = document.createElement('pre');
  pre.style.cssText = 'font:8px monospace;white-space:pre-wrap;word-break:break-all;margin:0';
  pre.textContent = out.join('\\n');
  document.body.appendChild(pre);
  window.parityDone = true;
})();`;

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Measures `units` (each a group id and its texts) in one Gotenberg print: per group, each text's width. */
export async function measureGroups(gotenberg: Gotenberg, units: ReadonlyArray<{ id: string; cellStyle: string; cls: string; texts: readonly string[] }>): Promise<Map<string, number[]>> {
  const body = units.map((u) => inTableCell(u.id, u.cellStyle, ['||', ...u.texts.map((t) => `|${t}|`)]
    .map((t) => `<div><span class="${u.cls}">${escape(t)}</span></div>`).join(''))).join('');
  const { html, fonts } = parityDocument(body);
  const page = html.replace(/<script>[\s\S]*<\/script>/, `<script>${SCRIPT(JSON.stringify(units.map((u) => u.id)))}</script>`);
  const text = withPdfFile(await gotenbergPdf(gotenberg, page, fonts, 'window.parityDone === true'),
    (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const flat = text.replace(/\s+/g, '');
  const out = new Map<string, number[]>();
  for (const u of units) {
    const m = new RegExp(`\\[${u.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|([0-9a-z]*)\\]`).exec(flat);
    if (m === null) throw new Error(`no report for ${u.id}`);
    const size = u.id.includes(':x') ? 3 : 2;
    const values = (m[1]!.match(new RegExp(`.{${size}}`, 'g')) ?? []).map((d) => Number.parseInt(d, 36));
    if (values.length !== u.texts.length) throw new Error(`${u.id}: ${values.length} widths for ${u.texts.length} texts`);
    out.set(u.id, values);
  }
  return out;
}

const glyph = (cp: number): string => (cp >= 0xd800 && cp <= 0xdfff ? '' : String.fromCodePoint(cp));

/** Each style's advance of every code point FIRST..LAST in whole pixels (rounded up), measured in the image. */
export async function measureAdvances(gotenberg: Gotenberg): Promise<Record<FallbackStyle, number[]>> {
  const result = {} as Record<FallbackStyle, number[]>;
  for (const [style, cellStyle, cls] of STYLES) {
    const all: number[] = [];
    for (let from = FIRST; from <= LAST; from += CHUNK) {
      const cps = Array.from({ length: Math.min(CHUNK, LAST + 1 - from) }, (unused, i) => from + i);
      const id = `${style}:${from.toString(16)}`;
      all.push(...(await measureGroups(gotenberg, [{ id, cellStyle, cls, texts: cps.map(glyph) }])).get(id)!);
    }
    result[style] = all;
  }
  return result;
}

/** Each style's widest emoji presentation, and its fingerprint (exact widths in 1/64px), measured in the image. */
export async function measureEmojiAndFingerprint(gotenberg: Gotenberg): Promise<{ emoji: Record<FallbackStyle, number>; fingerprint: Record<FallbackStyle, number[]> }> {
  const units = STYLES.flatMap(([style, cellStyle, cls]) => [
    { id: `${style}:emoji`, cellStyle, cls, texts: emojiPresentations() },
    { id: `${style}:x`, cellStyle, cls, texts: FINGERPRINT_CLUSTERS },
  ]);
  const res = await measureGroups(gotenberg, units);
  const emoji = {} as Record<FallbackStyle, number>;
  const fingerprint = {} as Record<FallbackStyle, number[]>;
  for (const [style] of STYLES) {
    emoji[style] = Math.max(...res.get(`${style}:emoji`)!);
    fingerprint[style] = res.get(`${style}:x`)!;
  }
  return { emoji, fingerprint };
}

/** The bases a mark is measured on: narrow and wide, a letter, a symbol, a digit, an ideograph. */
export const MARK_BASES = ['n', 'A', 'W', '&', 'x', '1', 'i', '\u4E2D'];

/**
 * Each style's price of every combining mark (\p{M}, FIRST..LAST): the most it adds to any of `MARK_BASES` in the
 * image (the cluster's width less the base's), in whole pixels rounded up. A mark the faces lack is drawn from a
 * fallback face, often wider than nothing ("A\u20D7" is 13.36px, "A" 8px at 12px/400).
 */
export async function measureMarks(gotenberg: Gotenberg): Promise<Record<FallbackStyle, Map<number, number>>> {
  const marks: number[] = [];
  for (let cp = FIRST; cp <= LAST; cp += 1) if (/\p{M}/u.test(glyph(cp))) marks.push(cp);
  const result = {} as Record<FallbackStyle, Map<number, number>>;
  for (const [style, cellStyle, cls] of STYLES) {
    const units = MARK_BASES.map((b, k) => ({ id: `${style}:x${k}`, cellStyle, cls, texts: [b, ...marks.map((m) => `${b}${String.fromCodePoint(m)}`)] }));
    const res = await measureGroups(gotenberg, units);
    const adds = new Map<number, number>();
    MARK_BASES.forEach((unused, k) => {
      const w = res.get(`${style}:x${k}`)!;
      marks.forEach((m, i) => { const px = Math.max(0, Math.ceil((w[i + 1]! - w[0]!) / 64 - 0.001)); if (px > (adds.get(m) ?? 0)) adds.set(m, px); });
    });
    result[style] = adds;
  }
  return result;
}
