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
import * as fontkit from 'fontkit';
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { printStylesheet } from '../print/renderPackPdf';

const ROOT = path.resolve(__dirname, '../../..');

/** The width production prints a page's content at (`PRINT_CONTENT_PX`): both engines lay the page out at it. */
export const PARITY_WIDTH_PX = PRINT_CONTENT_PX.portrait;

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

/**
 * Every code point a self-hosted face of the print stylesheet has a glyph for (the union over its woff2 files), from
 * U+0020: Chromium sets these from the same file on every host, so the two engines must agree on each.
 */
export function selfHostedCodePoints(): number[] {
  const cps = new Set<number>();
  for (const font of flatStylesheet().fonts) {
    const face = fontkit.openSync(font.file) as unknown as { characterSet: number[] };
    for (const cp of face.characterSet) if (cp >= 0x20) cps.add(cp);
  }
  return [...cps].sort((a, b) => a - b);
}

/** Who answers for the code points outside the self-hosted faces, which each host sets in its own fallback fonts. */
export const FALLBACK_OWNER = 'every other code point is set in the render host\'s fallback fonts; its width is owned by the tables '
  + 'measured in the production Gotenberg image (packReasonWidth\'s fallback blocks, the label-glyph table) and held to that '
  + 'image by the render-time fingerprint guard';
