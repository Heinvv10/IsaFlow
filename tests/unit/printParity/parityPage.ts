/**
 * ONE DOCUMENT, TWO ENGINES: the page both Chromiums of `packEngineParity.test.ts` lay out, and what they report.
 *
 * The page is the pack's real print stylesheet with its self-hosted faces, the units to compare (each an element
 * carrying `data-parity="<id>"`) and a script. Once every face has loaded, the script reads the box of every element
 * and of every line of every text node in each unit, in document order, and reduces each unit to its count of numbers
 * and an FNV-1a hash of them, written exactly as the engine returns them. It then replaces the document with those
 * lines (`P|<id>|<count>|<hash>`) and sets `window.parityDone`: Gotenberg prints them into a PDF, Playwright reads
 * them off the page. Nothing in it depends on which engine runs it, so equal lines are an equal layout.
 */
import path from 'node:path';
import { printStylesheet } from '../print/renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');

/** The print's content width (174mm), as `printBoardPack`'s viewport sets it. */
export const PARITY_WIDTH_PX = 658;

export interface FontFile { name: string; file: string }

const SCRIPT = `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  var fnv = function (s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
  var lines = [];
  document.querySelectorAll('[data-parity]').forEach(function (unit) {
    var parts = [];
    var walk = document.createTreeWalker(unit, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (var n = walk.currentNode; n !== null; n = walk.nextNode()) {
      var rects = [];
      if (n.nodeType === 1) rects = [n.getBoundingClientRect()];
      else { var range = document.createRange(); range.selectNodeContents(n); rects = Array.from(range.getClientRects()); }
      rects.forEach(function (r) { parts.push(r.x, r.y, r.width, r.height); });
    }
    lines.push('P|' + unit.getAttribute('data-parity') + '|' + parts.length + '|' + fnv(parts.join(',')));
  });
  document.documentElement.className = '';
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  var pre = document.createElement('pre');
  pre.id = 'parity-out';
  pre.style.cssText = 'font:7px monospace;white-space:pre;margin:0';
  pre.textContent = lines.join('\\n');
  document.body.appendChild(pre);
  window.parityDone = true;
})();`;

/** The stylesheet's faces, each referenced by its bare file name (Gotenberg serves the files it is sent flat). */
function flatStylesheet(): { css: string; fonts: FontFile[] } {
  const fonts = new Map<string, string>();
  const css = printStylesheet().replace(/url\((['"]?)\/fonts\/([^'")]+)\1\)/g, (unused, quote: string, rel: string) => {
    const name = path.basename(rel);
    fonts.set(name, path.join(ROOT, 'public/fonts', rel));
    return `url('${name}')`;
  });
  return { css, fonts: [...fonts].map(([name, file]) => ({ name, file })) };
}

/** The page holding `body` (its units marked `data-parity`), and the font files it loads. */
export function parityDocument(body: string): { html: string; fonts: FontFile[] } {
  const { css, fonts } = flatStylesheet();
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${css}html{width:${PARITY_WIDTH_PX}px}</style></head><body>${body}<script>${SCRIPT}</script></body></html>`;
  return { html, fonts };
}

/** The `P|` lines of a report, keyed by unit. */
export function parseReport(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^P\|([^|]+)\|(\d+)\|([0-9a-f]+)\s*$/.exec(line.trim());
    if (m) out.set(m[1]!, `${m[2]}|${m[3]}`);
  }
  return out;
}

/** The probe context `measureWidths.ts` sets a glyph in: a `.pack-table` cell on a `.pack-page`. */
export function inTableCell(id: string, cellStyle: string, inner: string): string {
  return `<div class="pack-pages"><div class="pack-page"><table class="pack-table"><tbody><tr><td data-parity="${id}" style="${cellStyle}">${inner}</td></tr></tbody></table></div></div>`;
}
