/**
 * The Blob the attachment viewer shows for one file, and whether it is still on its way.
 *
 * A stored attachment is a data URL and decodes at once. A captured document is fetched from its same-origin route
 * (capture/capturedAttachmentLinks) and typed from its own first bytes: a document that claims to be a PDF but is not
 * one shows "Preview not available", never its content.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { bytesToBlob, dataUrlToBlob, isCapturedFile, previewKind } from './attachmentPreview';

export interface BlobFile { file_url: string; content_type?: string | null }

/** missing: the server has no bytes for it (404), as opposed to bytes it will not show. */
/** failed: the fetch did not complete (network, 5xx); retry() asks again. */
export type AttachmentBlob = { blob: Blob | null; loading: boolean; missing: boolean; failed: boolean; retry: () => void };

type Loaded = { blob: Blob | null; missing: boolean; failed: boolean };

export function useAttachmentBlob(file: BlobFile | undefined): AttachmentBlob {
  const captured = !!file && isCapturedFile(file.file_url);
  const kind = file ? previewKind(file.file_url, file.content_type) : 'none';
  const decoded = useMemo(
    () => (file && !captured && kind !== 'none' ? dataUrlToBlob(file.file_url) : null),
    [file, captured, kind],
  );

  // One request per document for as long as this viewer is open: a document can be up to 10 MB, stepping back to it
  // must not fetch it again, and StrictMode's second effect run reuses the first one's request.
  // A failure is not kept: stepping back to the document tries again.
  const requests = useRef(new Map<string, Promise<Loaded>>());
  // Keyed by the file it belongs to, so a step never shows the previous file's bytes while the next one loads.
  const [fetched, setFetched] = useState<({ file: BlobFile } & Loaded) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setFetched(null); setAttempt((n) => n + 1); };
  useEffect(() => {
    if (!file || !captured || kind === 'none') return undefined;
    let live = true;
    const cache = requests.current;
    let request = cache.get(file.file_url);
    if (!request) {
      request = loadCaptured(file.file_url);
      cache.set(file.file_url, request);
      void request.then((loaded) => { if (loaded.failed) cache.delete(file.file_url); });
    }
    void request.then((loaded) => { if (live) setFetched({ file, ...loaded }); });
    return () => { live = false; };
  }, [file, captured, kind, attempt]);

  const done = { loading: false, missing: false, failed: false, retry };
  if (!captured) return { ...done, blob: decoded };
  if (kind === 'none') return { ...done, blob: null };
  if (fetched && fetched.file === file) return { ...done, blob: fetched.blob, missing: fetched.missing, failed: fetched.failed };
  return { ...done, blob: null, loading: true };
}

/** failed: a fetch that did not complete (network, 5xx), worth retrying; a 404 is missing, not failed. */
async function loadCaptured(url: string): Promise<Loaded> {
  try {
    const res = await apiFetch(url);
    if (res.status === 404) return { blob: null, missing: true, failed: false };
    await assertOk(res, 'Could not load the document');
    return { blob: bytesToBlob(await res.arrayBuffer()), missing: false, failed: false };
  } catch (err) {
    log.warn('Attachment viewer could not load a captured document', { err }, 'attachment-viewer');
    return { blob: null, missing: false, failed: true };
  }
}
