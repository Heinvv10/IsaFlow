/**
 * Print-mode plumbing for the pack page.
 *
 * THE THEME FIGHT: ThemeContext defaults to dark and adds `.dark` to <html>
 * in a mount effect, so a child that simply removes the class is overwritten
 * a moment later — the PDF then prints white text on white paper. Writing the
 * stored preference in a LAYOUT effect wins instead: child layout effects run
 * before the provider's passive mount effect, so the provider reads 'light'
 * and takes the class off itself. The class is removed here too, for the
 * frame before the provider has re-rendered.
 *
 * THE READINESS GATE: the renderer waits for [data-print-ready="true"]
 * (src/lib/pdf/pdfTransport.ts). It is set only when the data has loaded, every
 * chart has actually drawn an <svg>, AND every font face the pack sets its
 * type in has loaded. There is deliberately no timeout that gives up and
 * prints anyway: a pack missing a chart is a document sent to a client with a
 * hole in it, and a hard render timeout is the loud, diagnosable failure we
 * want instead.
 *
 * THE FONTS ARE PART OF THAT, AND WERE NOT. `styles/packPrint.css` declares
 * all three IBM Plex Sans faces `font-display: block`, which renders text in a
 * face that has not arrived as NOTHING — not as a fallback, and permanently if
 * the face never loads. The gate waited for the charts and not for the faces,
 * so a render that beat the font requests photographed a document whose every
 * 500- and 600-weight position was blank: the twelve-sheet pack at 4663a916
 * printed its KPI labels and no figures, five statement tables with no column
 * headers, six sparkline panels with no titles and a glossary with no terms,
 * while every 400-weight paragraph survived. Nothing downstream could see it —
 * the page count was right, the PDF was well-formed, and the sheet-count and
 * integrity gates all passed on it.
 *
 * WHY `document.fonts.ready` IS NOT THE CONDITION. It resolves when no font
 * load is PENDING, which is a statement about this instant rather than about
 * the document: a face first requested by a later paint starts its load after
 * `ready` has already resolved. So the gate names the faces instead — the
 * three `@font-face` rules packPrint.css declares — asks for each of them
 * itself, and only then checks that each one is actually available. There is
 * no fourth face for a later paint to discover; `fontsSelfHosted.test.ts`
 * holds that list to the stylesheet's.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import type { PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

const THEME_STORAGE_KEY = 'accounting-theme';
const CHART_POLL_MS = 100;

export function usePrintMode(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.add('print-mode');
    root.classList.remove('dark');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    } catch {
      // A headless context with storage disabled still prints: print.css
      // forces a white ground and dark ink on html.print-mode regardless,
      // and the class has already come off above.
    }
  }, [enabled]);
}

/** Chart blocks across the whole document — what usePrintReady waits for. */
export function countCharts(sections: PackDocumentSection[]): number {
  return sections.reduce(
    (total, section) => total + section.blocks.filter((b) => b.kind === 'waterfall' || b.kind === 'trend').length,
    0,
  );
}

/**
 * Chart blocks across the fixed-page pack model — the Task-12+ counterpart
 * of `countCharts` above. That function stays untouched: `PackPrintView`
 * still dispatches to it for `pack=management`/`pack=monthly` via
 * `PackDocumentSection`, a different shape than `PackPage`. The two are
 * deleted together once the legacy pack path is retired.
 */
export function countPageModelCharts(pages: PackPage[]): number {
  return pages.reduce(
    (total, page) => total + page.blocks.reduce((pageTotal, block) => {
      if (block.kind === 'chart') return pageTotal + 1;
      if (block.kind === 'smallMultiples') return pageTotal + block.panels.length;
      return pageTotal;
    }, 0),
    0,
  );
}

/**
 * The family every pack position is set in, and the three weights it is set
 * at — the `@font-face` rules of `styles/packPrint.css`, named here so the
 * readiness gate can wait for exactly them.
 *
 * Exported for `tests/unit/print/fontsSelfHosted.test.ts`, which reads the
 * stylesheet and fails when a face is declared there and missing here. A face
 * this list does not name is a face the gate does not wait for, which is the
 * whole defect.
 */
export const PACK_FONT_FAMILY = 'IBM Plex Sans';
export const PACK_FONT_WEIGHTS = [400, 500, 600] as const;

/**
 * The shorthand `FontFaceSet` matches faces by. The size is arbitrary and
 * required — the shorthand does not parse without one — and does not select a
 * face: `@font-face` matching is on family, weight and style.
 */
function faceSpec(weight: number): string {
  return `${weight} 1em "${PACK_FONT_FAMILY}"`;
}

/**
 * DIGITS, NOT THE DEFAULT SPACE. `FontFaceSet.check(font)` defaults its text
 * to a single space, and a space is present in every fallback — so the check
 * can pass on a face that has not loaded a glyph the pack actually prints.
 * The figures are what went missing, so the figures are what is asked about.
 */
const FIGURE_GLYPHS = '0123456789()–';

/**
 * Every declared face, requested and then verified. Resolves false when one
 * of them is not available afterwards, which keeps the page from ever
 * becoming print-ready — the renderer then fails on its own timeout, loudly,
 * instead of photographing a document with no figures on it.
 *
 * Exported for the test that drives it against a stubbed `FontFaceSet`.
 */
export async function packFontsLoaded(target: Document): Promise<boolean> {
  const fonts = (target as Document & { fonts?: FontFaceSet }).fonts;
  // No CSS Font Loading API at all — jsdom, and browsers older than anything
  // that runs this pack. Nothing can be awaited and nothing can be verified,
  // so the gate declines to block on a question it cannot ask.
  if (fonts === undefined) return true;
  await Promise.all(PACK_FONT_WEIGHTS.map((weight) => fonts.load(faceSpec(weight), FIGURE_GLYPHS)));
  // `load()` resolves with the faces it matched — including with none at all,
  // for a family the document never declared. `ready` then settles whatever
  // else the page has started, and `check()` is the actual assertion.
  await fonts.ready;
  return PACK_FONT_WEIGHTS.every((weight) => fonts.check(faceSpec(weight), FIGURE_GLYPHS));
}

/**
 * True once the fonts have loaded. Stays false forever when one never does —
 * see `packFontsLoaded`.
 */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let live = true;
    void packFontsLoaded(document).then((loaded) => {
      if (live && loaded) setReady(true);
    });
    return () => { live = false; };
  }, []);

  return ready;
}

export function usePrintReady(dataReady: boolean, expectedCharts: number): boolean {
  const [chartsReady, setChartsReady] = useState(false);
  const fontsReady = useFontsReady();

  useEffect(() => {
    if (!dataReady) return;
    if (expectedCharts === 0) { setChartsReady(true); return; }

    const check = () => document.querySelectorAll('[data-pack-chart] svg').length >= expectedCharts;
    if (check()) { setChartsReady(true); return; }

    const timer = window.setInterval(() => {
      if (check()) {
        window.clearInterval(timer);
        setChartsReady(true);
      }
    }, CHART_POLL_MS);
    return () => window.clearInterval(timer);
  }, [dataReady, expectedCharts]);

  return chartsReady && fontsReady;
}
