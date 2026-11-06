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

export type AttachmentBlob = { blob: Blob | null; loading: boolean };

export function useAttachmentBlob(file: BlobFile | undefined): AttachmentBlob {
  const captured = !!file && isCapturedFile(file.file_url);
  const kind = file ? previewKind(file.file_url, file.content_type) : 'none';
  const decoded = useMemo(
    () => (file && !captured && kind !== 'none' ? dataUrlToBlob(file.file_url) : null),
    [file, captured, kind],
  );

  // One request per document for as long as this viewer is open: a document can be up to 10 MB, stepping back to it
  // must not fetch it again, and StrictMode's second effect run reuses the first one's request.
  const requests = useRef(new Map<string, Promise<Blob | null>>());
  // Keyed by the file it belongs to, so a step never shows the previous file's bytes while the next one loads.
  const [fetched, setFetched] = useState<{ file: BlobFile; blob: Blob | null } | null>(null);
  useEffect(() => {
    if (!file || !captured || kind === 'none') return undefined;
    let live = true;
    let request = requests.current.get(file.file_url);
    if (!request) {
      request = loadCaptured(file.file_url);
      requests.current.set(file.file_url, request);
    }
    void request.then((blob) => { if (live) setFetched({ file, blob }); });
    return () => { live = false; };
  }, [file, captured, kind]);

  if (!captured) return { blob: decoded, loading: false };
  if (kind === 'none') return { blob: null, loading: false };
  if (fetched && fetched.file === file) return { blob: fetched.blob, loading: false };
  return { blob: null, loading: true };
}

async function loadCaptured(url: string): Promise<Blob | null> {
  try {
    const res = await apiFetch(url);
    await assertOk(res, 'Could not load the document');
    return bytesToBlob(await res.arrayBuffer());
  } catch (err) {
    log.warn('Attachment viewer could not load a captured document', { err }, 'attachment-viewer');
    return null;
  }
}
