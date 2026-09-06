/**
 * The printed pack's two fetches, and only those two.
 *
 * The set here must match `packPrintApiPaths` exactly: the renderer stubs
 * every other /api/* call with an empty envelope, so a third fetch added here
 * would not 401 — it would silently return nothing and the PDF would ship
 * showing a loading state. packPrintFetchParity.dom.test.tsx pins the two
 * lists together.
 *
 * `apiJson`, not `apiFetch`: an envelope or field-name change becomes a
 * compile error rather than a document full of zeros.
 */
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { buildPackDocument, type PackDocument } from '@/modules/accounting/services/packs/packDocument';
import { PACK_DATA_API, packTrendApiPath } from '@/modules/accounting/services/packs/packSections';
import type { PackType, ReportPack } from '@/modules/accounting/services/reports/reportPackService';

export interface PackPrintData {
  document: PackDocument | null;
  error: string | null;
}

export function usePackPrintData(packType: PackType, from: string, to: string): PackPrintData {
  const [document, setDocument] = useState<PackDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // `reports-pack` is not in the route registry and its GET returns
        // three fields; registering the shared path would have to hold for
        // every method on it, so the payload is narrowed with one cast here.
        const packPayload = (await apiJson(
          `${PACK_DATA_API}?type=${packType}&from=${from}&to=${to}`,
        )) as { pack: ReportPack };
        const trend = await apiJson(`${packTrendApiPath(packType)}?to=${to}&months=12`);
        if (cancelled) return;
        setDocument(buildPackDocument(packPayload.pack, trend));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('usePackPrintData: failed', { packType, from, to, error: message });
        if (!cancelled) setError(message);
      }
    })();
    return () => { cancelled = true; };
  }, [packType, from, to]);

  return { document, error };
}
