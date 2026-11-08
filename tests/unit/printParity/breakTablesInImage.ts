/**
 * THE BREAK TABLES, SCANNED IN PRODUCTION'S IMAGE. Which code points Chromium breaks between (`packBreakRanges.ts`) and
 * which hold to a soft hyphen or a zero-width space (`packSoftBreakRanges.ts`) depend on the fonts the host sets them
 * in: a code point the pack's faces lack is set in a fallback font, and the line breaker reads that font's glyph. So
 * the tables are production's Gotenberg image's: the same scans the tables were first made with, run in a throwaway
 * container of the image (`gotenbergParity.ts`), the result printed into the PDF and read back.
 */
import { execFileSync } from 'node:child_process';
import { gotenbergPdf, withPdfFile, type Gotenberg } from './gotenbergParity';
import { flatStylesheet } from './parityPage';

export type Ranges = Array<[number, number]>;

/** `codes` (sorted) as inclusive ranges. */
export function toRanges(codes: readonly number[]): Ranges {
  const out: Ranges = [];
  for (const c of codes) {
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === c - 1) last[1] = c; else out.push([c, c]);
  }
  return out;
}

const SCAN = `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  var lines = [];
  function emit(tag, codes) {
    var start = null; var prev = null;
    codes.forEach(function (c) {
      if (start !== null && c === prev + 1) { prev = c; return; }
      if (start !== null) lines.push('R|' + tag + '|' + start.toString(16) + '|' + prev.toString(16));
      start = c; prev = c;
    });
    if (start !== null) lines.push('R|' + tag + '|' + start.toString(16) + '|' + prev.toString(16));
    lines.push('N|' + tag + '|' + codes.length);
  }
  // Self-breaking: a run of four whose min-content width is narrower than its single-line width (14px sans-serif).
  var skip = /[\\p{M}\\p{Cc}\\p{Cf}\\p{Cn}\\p{Co}\\p{Cs}\\p{Z}]|[\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}\\p{Script=Balinese}\\p{Script=Batak}\\p{Script=Javanese}\\p{Script=Sundanese}\\p{Script=Cham}\\p{Script=Tai_Le}\\p{Script=New_Tai_Lue}\\p{Script=Tai_Tham}\\p{Script=Tai_Viet}]/u;
  var host = document.getElementById('scan');
  var candidates = [];
  [[0xa0, 0xffff], [0x10000, 0x1ffff], [0x20000, 0x323af]].forEach(function (r) { for (var cp = r[0]; cp <= r[1]; cp += 1) if (!skip.test(String.fromCodePoint(cp))) candidates.push(cp); });
  var breaking = [];
  for (var i = 0; i < candidates.length; i += 8192) {
    var batch = candidates.slice(i, i + 8192);
    var pairs = batch.map(function (cp) {
      var a = document.createElement('div'); var b = document.createElement('div');
      a.className = 'a'; b.className = 'b';
      a.textContent = String.fromCodePoint(cp).repeat(4); b.textContent = a.textContent;
      host.append(a, b); return [a, b];
    });
    pairs.forEach(function (p, j) { if (p[0].getBoundingClientRect().width < p[1].getBoundingClientRect().width - 0.5) breaking.push(batch[j]); });
    host.replaceChildren();
  }
  emit('break', breaking);
  // Holds: "ab" + separator + X + "cd" at its narrowest in the reason's style, X on the line of the "b".
  var skip2 = /[\\p{Cn}\\p{Cs}\\p{Co}]/u;
  var all = [];
  [[0x20, 0xffff], [0x10000, 0x1ffff], [0x20000, 0x323af], [0xe0000, 0xe01ef]].forEach(function (r) { for (var cp = r[0]; cp <= r[1]; cp += 1) if (!skip2.test(String.fromCodePoint(cp))) all.push(cp); });
  var td = document.getElementById('label');
  [['shy', '\\u00AD'], ['zwsp', '\\u200B']].forEach(function (pair) {
    var held = [];
    for (var k = 0; k < all.length; k += 4096) {
      var chunk = all.slice(k, k + 4096);
      td.textContent = '';
      var spans = chunk.map(function (cp) {
        var box = document.createElement('div'); box.style.cssText = 'width:0;white-space:normal';
        var span = document.createElement('span'); span.className = 'pack-kpi-unavailable';
        span.textContent = 'ab' + pair[1] + String.fromCodePoint(cp) + 'cd';
        box.appendChild(span); td.appendChild(box); return span;
      });
      spans.forEach(function (span, j) {
        var node = span.firstChild;
        var rects = function (from, to) { var r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getClientRects(); };
        var lastTop = function (list) { return list[list.length - 1].top; };
        var width = String.fromCodePoint(chunk[j]).length;
        var x = rects(3, 3 + width);
        var xTop = x.length > 0 ? lastTop(x) : lastTop(rects(3 + width, 4 + width));
        if (Math.abs(xTop - lastTop(rects(1, 2))) < 1) held.push(chunk[j]);
      });
    }
    emit(pair[0], held);
  });
  document.documentElement.className = '';
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  var pre = document.createElement('pre');
  pre.style.cssText = 'font:7px monospace;white-space:pre-wrap;margin:0';
  pre.textContent = lines.join('\\n');
  document.body.appendChild(pre);
  window.parityDone = true;
})();`;

export interface ImageBreakTables { selfBreaking: Ranges; softHyphenHolds: Ranges; zeroWidthSpaceHolds: Ranges }

/** The three tables as production's image scans them. */
export async function scanBreakTables(gotenberg: Gotenberg): Promise<ImageBreakTables> {
  const { css, fonts } = flatStylesheet();
  const body = '<div id="scan"></div><div class="pack-pages"><div class="pack-page"><table class="pack-table"><tbody><tr><td id="label">x</td></tr></tbody></table></div></div>';
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${css}#scan{font:14px sans-serif}#scan .a{width:min-content;white-space:normal}#scan .b{width:max-content;white-space:nowrap}</style>`
    + `</head><body>${body}<script>${SCAN}</script></body></html>`;
  const text = withPdfFile(await gotenbergPdf(gotenberg, html, fonts, 'window.parityDone === true'),
    (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const ranges: Record<string, Ranges> = { break: [], shy: [], zwsp: [] };
  const counts: Record<string, number> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const r = /^R\|(break|shy|zwsp)\|([0-9a-f]+)\|([0-9a-f]+)$/.exec(line);
    if (r) ranges[r[1]!]!.push([parseInt(r[2]!, 16), parseInt(r[3]!, 16)]);
    const n = /^N\|(break|shy|zwsp)\|(\d+)$/.exec(line);
    if (n) counts[n[1]!] = Number(n[2]);
  }
  for (const tag of ['break', 'shy', 'zwsp']) {
    const total = ranges[tag]!.reduce((s, [a, b]) => s + b - a + 1, 0);
    if (counts[tag] === undefined || counts[tag] !== total) throw new Error(`the image's ${tag} scan came back incomplete (${total} of ${counts[tag] ?? '?'})`);
  }
  return { selfBreaking: ranges.break!, softHyphenHolds: ranges.shy!, zeroWidthSpaceHolds: ranges.zwsp! };
}
