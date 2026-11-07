/**
 * WHICH PAGES OF A PACK RUN PAST THE RIGHT EDGE IN PRODUCTION'S IMAGE: the packs are set side by side in one document
 * at the width production prints at (`parityPage.ts`), a throwaway Gotenberg of the image lays them out with its own
 * fallback fonts, and a script reports, per pack, every portrait page wider than `PRINT_CONTENT_PX` and by how much.
 * The report comes back as the text of the PDF Gotenberg prints. For a glyph only the image's fonts can measure.
 */
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { gotenbergPdf, withPdfFile, type Gotenberg } from './gotenbergParity';
import { parityDocument } from './parityPage';

const SCRIPT = (limit: number): string => `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  var lines = [];
  document.querySelectorAll('[data-overflow]').forEach(function (pack) {
    var over = [];
    pack.querySelectorAll('.pack-page:not([data-print-landscape])').forEach(function (page) {
      var past = page.scrollWidth - ${limit};
      if (past > 0) over.push(page.id + ':' + past.toFixed(3));
    });
    lines.push('O|' + pack.getAttribute('data-overflow') + '|' + over.join(','));
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

/** For each pack, the ids of its portrait pages that run past the right edge in the image (empty where none does). */
export async function gotenbergOverflow(gotenberg: Gotenberg, docs: readonly PackPagesDocument[]): Promise<string[][]> {
  const body = docs.map((doc, i) => `<div data-overflow="${i}">${renderToStaticMarkup(createElement(PackPagesView, { document: doc }))}</div>`).join('');
  const { html, fonts } = parityDocument(body);
  const page = html.replace(/<script>[\s\S]*<\/script>/, `<script>${SCRIPT(PRINT_CONTENT_PX.portrait)}</script>`);
  const text = withPdfFile(await gotenbergPdf(gotenberg, page, fonts, 'window.parityDone === true'),
    (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const out = docs.map((): string[] | null => null);
  for (const line of text.split('\n')) {
    const m = /^O\|(\d+)\|(.*)$/.exec(line.trim());
    if (m) out[Number(m[1])] = m[2] === '' ? [] : m[2]!.split(',').map((p) => p.split(':')[0]!);
  }
  if (out.some((o) => o === null)) throw new Error('Gotenberg did not report every pack');
  return out as string[][];
}
