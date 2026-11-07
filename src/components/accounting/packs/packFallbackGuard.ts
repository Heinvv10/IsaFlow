/**
 * THE RENDER HOST'S FALLBACK FONTS ARE THE ONES THE FIT MODEL WAS MEASURED IN, OR THE PACK DOES NOT PRINT.
 *
 * A glyph the pack's self-hosted faces lack is set in the render host's own fallback fonts, and the fit model prices it
 * from tables measured in production's Gotenberg image (`packFallbackWidthData.ts`). On any other font set those
 * prices mean nothing: a row the model passed could run off the sheet. So, once the page has its data and its faces,
 * if a modelled position (a KPI tile's label, reason or delta line, a statement row's label) holds a glyph outside the
 * self-hosted faces, the page re-measures the fingerprint (`FINGERPRINT_CLUSTERS`, in each style, exactly as the
 * generator measured it) and says what differs. The caller marks the page unprintable (`markPrintError('fonts')`).
 * A pack set wholly in the self-hosted faces never takes the measurement and prints on any host.
 */
import { FALLBACK, FINGERPRINT_CLUSTERS, SELF_HOSTED, type FallbackStyle } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';

/** The positions the fit model prices a fallback glyph in. */
export const MODELLED_TEXT = '.pack-kpi-label, .pack-kpi-unavailable, .pack-kpi-delta, .pack-table td:first-child';

const STYLE_CELL: ReadonlyArray<readonly [FallbackStyle, string, string]> = [
  ['reason', '', 'pack-kpi-unavailable'], ['label400', 'font-weight:400', ''], ['label500', 'font-weight:500', ''], ['label600', 'font-weight:600', ''],
];

function selfHosted(cp: number): boolean {
  let lo = 0;
  let hi = SELF_HOSTED.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = SELF_HOSTED[mid]!;
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Does any modelled position of `root` hold a code point outside the self-hosted faces? */
export function usesFallbackGlyphs(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll(MODELLED_TEXT)).some((el) => Array.from(el.textContent ?? '')
    .some((ch) => { const cp = ch.codePointAt(0)!; return cp >= 0x20 && !/\s/.test(ch) && !selfHosted(cp); }));
}

/** The fingerprint clusters' widths on this host, in 1/64px, per style, measured as the generator measures them. */
export function measureFingerprint(doc: Document): Record<FallbackStyle, number[]> {
  const host = doc.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden';
  host.innerHTML = '<div class="pack-pages"><div class="pack-page"><table class="pack-table"><tbody><tr><td></td></tr></tbody></table></div></div>';
  doc.body.appendChild(host);
  try {
    const td = host.querySelector('td')!;
    const out = {} as Record<FallbackStyle, number[]>;
    for (const [style, cellStyle, cls] of STYLE_CELL) {
      td.style.cssText = cellStyle;
      td.textContent = '';
      const spans = ['||', ...FINGERPRINT_CLUSTERS.map((c) => `|${c}|`)].map((text) => {
        const span = doc.createElement('span');
        span.className = cls;
        span.textContent = text;
        td.appendChild(doc.createElement('div')).appendChild(span);
        return span;
      });
      const bars = spans[0]!.getBoundingClientRect().width;
      out[style] = spans.slice(1).map((s) => Math.ceil((s.getBoundingClientRect().width - bars) * 64 - 0.001));
    }
    return out;
  } finally {
    host.remove();
  }
}

/** Null where the page may print; otherwise why not (the fingerprint clusters whose width differs on this host). */
export function fallbackFontsVerdict(doc: Document): string | null {
  if (!usesFallbackGlyphs(doc)) return null;
  const measured = measureFingerprint(doc);
  const wrong = STYLE_CELL.flatMap(([style]) => FINGERPRINT_CLUSTERS.flatMap((cluster, i) => (measured[style][i] === FALLBACK[style].fingerprint[i]
    ? [] : [`${style} ${JSON.stringify(cluster)} ${measured[style][i]}/64px, measured ${FALLBACK[style].fingerprint[i]}/64px`])));
  return wrong.length === 0 ? null
    : `a modelled position uses a fallback glyph and this host's fallback fonts are not production's image's: ${wrong.slice(0, 6).join('; ')}`;
}
