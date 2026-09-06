/**
 * The printed board pack's ONE fetch.
 *
 * The whole twelve-page document arrives composed, because its charts are
 * rendered by `renderChartSvg` — `node:crypto` plus ECharts, neither of which
 * a browser can run (`next.config.js` sets `crypto: false` in the client
 * webpack fallback). So this hook does no composing: it fetches, ADOPTS, and
 * hands over.
 *
 * The set here must match `packPrintApiPaths('board')` exactly. The renderer
 * stubs every unlisted /api/* call with an empty envelope, so a second fetch
 * added here would not 401 — it would silently return nothing and the PDF
 * would ship showing a loading state. packPrintFetchParity.dom.test.tsx pins
 * the two lists together.
 *
 * `apiJson`, not `apiFetch`: the document's shape is resolved off the route
 * registry, so a wire-shape change is a compile error rather than a printed
 * pack full of blanks.
 *
 * ADOPTION CAN THROW, AND SHOULD. `adoptPackPagesDocument` re-runs the two
 * chart guards on every SVG that crossed the JSON boundary. A chart that
 * fails them lands in `error` here, the page never becomes print-ready, and
 * the render times out loudly — which is the wanted outcome, because the
 * alternative is a document sent to a board with unvetted markup in it.
 */
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { packPagesApiPath } from '@/modules/accounting/services/packs/packSections';
import { adoptPackPagesDocument } from '@/modules/accounting/services/packs/pages/packDocumentWire';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

export interface PackPagesData {
  document: PackPagesDocument | null;
  error: string | null;
}

export function usePackPagesData(packType: PackType, from: string, to: string): PackPagesData {
  const [document, setDocument] = useState<PackPagesDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await apiJson(`${packPagesApiPath(packType)}?from=${from}&to=${to}`);
        // Adopted BEFORE the cancellation check, so a document that fails the
        // guards is reported even if this effect has been superseded — a
        // refusal is a fact about the payload, not about this render.
        const adopted = adoptPackPagesDocument(raw);
        if (cancelled) return;
        setDocument(adopted);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('usePackPagesData: failed', { packType, from, to, error: message });
        if (!cancelled) setError(message);
      }
    })();
    return () => { cancelled = true; };
  }, [packType, from, to]);

  return { document, error };
}
