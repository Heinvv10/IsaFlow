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
 * (src/lib/pdf/pdfTransport.ts). It is set only when the data has loaded AND
 * every chart has actually drawn an <svg>. There is deliberately no timeout
 * that gives up and prints anyway: a pack missing a chart is a document sent
 * to a client with a hole in it, and a hard render timeout is the loud,
 * diagnosable failure we want instead.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import type { PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';

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

export function usePrintReady(dataReady: boolean, expectedCharts: number): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!dataReady) return;
    if (expectedCharts === 0) { setReady(true); return; }

    const check = () => document.querySelectorAll('[data-pack-chart] svg').length >= expectedCharts;
    if (check()) { setReady(true); return; }

    const timer = window.setInterval(() => {
      if (check()) {
        window.clearInterval(timer);
        setReady(true);
      }
    }, CHART_POLL_MS);
    return () => window.clearInterval(timer);
  }, [dataReady, expectedCharts]);

  return ready;
}
