/**
 * A PAGE SCRIPT RUN IN PRODUCTION'S IMAGE, ITS LINES READ BACK: the image tests' one way to ask production's Chromium.
 */
import { execFileSync } from 'node:child_process';
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { gotenbergPdf, withPdfFile, type Gotenberg } from './gotenbergParity';
import { flatStylesheet } from './parityPage';

/** A page to probe in: the pack's page box, with a `#scan` host. */
export const PROBE_BODY = '<div class="pack-pages"><div class="pack-page"><div id="scan"></div></div></div>';

/**
 * `script` (defining `answer()`, which returns lines) run in `gotenberg` over the pack's stylesheet and `body` (a page to
 * probe in, or a pack's pages laid out at production's print width), its lines read back.
 */
export async function inImage(gotenberg: Gotenberg, script: string, body = PROBE_BODY): Promise<string[]> {
  const { css, fonts } = flatStylesheet();
  const run = `(async function () {
  await Promise.all(Array.from(document.fonts).map(function (f) { return f.load().catch(function () { return null; }); }));
  await document.fonts.ready;
  ${script}
  var lines = answer();
  document.documentElement.className = ''; document.head.innerHTML = ''; document.body.innerHTML = '';
  var pre = document.createElement('pre'); pre.style.cssText = 'font:7px monospace;white-space:pre;margin:0';
  pre.textContent = lines.join('\\n'); document.body.appendChild(pre);
  window.parityDone = true;
})();`;
  const html = '<!doctype html><html class="print-mode"><head><meta charset="utf-8">'
    + `<style>${css}html{width:${PRINT_CONTENT_PX.portrait}px}</style></head><body>${body}<script>${run}</script></body></html>`;
  const pdf = await gotenbergPdf(gotenberg, html, fonts, 'window.parityDone === true');
  return withPdfFile(pdf, (file) => execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).split('\n').map((l) => l.trim());
}

/** `texts`' breaks in production, by `breaksOf` (the census's page script), 15,000 a print. */
export async function breaksInImage(gotenberg: Gotenberg, breaksOfScript: string, texts: readonly string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let at = 0; at < texts.length; at += 15_000) {
    const slice = texts.slice(at, at + 15_000);
    const lines = await inImage(gotenberg, `${breaksOfScript}\nfunction answer() { return breaksOf(${JSON.stringify(slice)}).map(function (b) { return 'B|' + b.join(','); }); }`);
    const got = lines.filter((l) => l.startsWith('B|')).map((l) => (l.length > 2 ? l.slice(2).split(',').map(Number) : []));
    if (got.length !== slice.length) throw new Error(`the image's census came back incomplete: ${got.length} of ${slice.length}`);
    out.push(...got);
  }
  return out;
}
