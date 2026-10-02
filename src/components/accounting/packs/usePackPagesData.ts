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
 * TWO FETCHES PER RENDER IN DEV ARE STRICT MODE, NOT A BUG HERE.
 * `next.config.js` sets `reactStrictMode: true`, so React 18 mounts, unmounts
 * and remounts every component in DEVELOPMENT — the effect below runs twice
 * and the log shows two requests with distinct request ids. It does not
 * happen in a production build. The `cancelled` flag is what makes the
 * duplicate harmless: the superseded run writes no state.
 *
 * ADOPTION CAN THROW, AND SHOULD. `adoptPackPagesDocument` re-runs the two
 * chart guards on every SVG that crossed the JSON boundary. A chart that
 * fails them lands in `error` here, the page never becomes print-ready, and
 * the render times out loudly — which is the wanted outcome, because the
 * alternative is a document sent to a board with unvetted markup in it.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { clearPrintError, markPrintError } from './usePrintMode';
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
        const raw = await apiJson(`${packPagesApiPath(packType)}?from=${from}&to=${to}`, undefined, 'The report pack pages could not be loaded. Try again.');
        // Adopted BEFORE the cancellation check, so a document that fails the
        // guards is reported even if this effect has been superseded — a
        // refusal is a fact about the payload, not about this render.
        const adopted = adoptPackPagesDocument(raw);
        if (cancelled) return;
        clearPrintError('pages');
        setDocument(adopted);
      } catch (err) {
        const message = apiErrorMessage(err, 'The report pack pages could not be loaded. Try again.');
        log.error('usePackPagesData: failed', { packType, from, to, error: err });
        // The status, never the body: this attribute is read by the render
        // route's logs, and a refusal body is a tenant-facing sentence.
        if (!cancelled) {
          markPrintError('pages', err instanceof ApiRequestError ? `HTTP ${err.status}` : err instanceof Error ? err.message : String(err));
          setError(message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [packType, from, to]);

  return { document, error };
}
