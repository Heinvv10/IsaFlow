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
import { apiJson, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { buildPackDocument, type PackDocument } from '@/modules/accounting/services/packs/packDocument';
import { PACK_DATA_API, packTrendApiPath } from '@/modules/accounting/services/packs/packSections';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

const PACK_FAILED = 'Could not load the pack - try again';

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
        // Typed by the route registry (`/api/accounting/reports-pack`), so a
        // renamed or removed field is a compile error here.
        const packPayload = await apiJson(`${PACK_DATA_API}?type=${packType}&from=${from}&to=${to}`, undefined, PACK_FAILED);
        const trend = await apiJson(`${packTrendApiPath(packType)}?to=${to}&months=12`, undefined, PACK_FAILED);
        if (cancelled) return;
        setDocument(buildPackDocument(packPayload.pack, trend, packPayload.draft === true));
      } catch (err) {
        log.error('usePackPrintData: failed', { packType, from, to, error: err instanceof Error ? err.message : String(err) });
        if (!cancelled) setError(apiErrorMessage(err, PACK_FAILED));
      }
    })();
    return () => { cancelled = true; };
  }, [packType, from, to]);

  return { document, error };
}
