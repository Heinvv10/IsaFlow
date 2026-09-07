/**
 * Downloading a generated pack, and saying why when it does not arrive.
 *
 * A hook rather than more of `report-packs.tsx`, which is at the repo's
 * 300-line ceiling — and the seam is a real one: everything here is about the
 * DOWNLOAD (which format is in flight, what the server refused and why), and
 * nothing about which pack is on screen.
 *
 * WHY THE ERROR IS STATE AND NOT A LOG LINE. `apiFetch` resolves on a 4xx, so
 * `assertOk` is what turns a refusal into a throw carrying the server's own
 * message. That message was then written to the console and dropped: the
 * reader watched the spinner stop and saw nothing. The figure integrity gate
 * (spec §7.2) refuses a pack whose balance sheet does not foot — a real
 * client's is out by R450 — and that sentence reaching a human IS the gate's
 * value. Returned here so the screen can print it.
 */
import { useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export type PackDownloadFormat = 'pdf' | 'pptx';

export interface PackDownloadRequest {
  packType: string;
  from: string;
  to: string;
}

export interface PackDownload {
  /** The format currently being generated, or null. */
  downloading: PackDownloadFormat | null;
  /** Why the last attempt failed, in the server's words. Null once a new
   *  attempt starts, so a stale refusal never sits above a fresh download. */
  error: string | null;
  download: (format: PackDownloadFormat) => Promise<void>;
}

/**
 * The name the server gave the file, or null.
 *
 * The server composes it with `packDownloadFilename`, which prefixes the
 * company slug — and that name never reached the browser, because this hook
 * set `a.download` to its own string and the header was read by nobody. Every
 * company's pack therefore saved as `report-pack-board-<from>-to-<to>.pdf`, so
 * a bureau user downloading packs for three clients gets three files with one
 * name and, in most browsers, silently keeps only the last.
 *
 * `filename*` (RFC 5987) first: it is the encoded form, and a server that
 * sends both means the plain `filename` as the ASCII fallback. Any path
 * separator, and any leading dot, is stripped — the header is server-composed
 * and already slugified, but `a.download` is not the place to find out that a
 * company name reached it raw.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const raw = encoded ? safeDecode(encoded[1] ?? '') : (plain?.[1] ?? plain?.[2] ?? '');
  const name = raw.trim().split(/[/\\]/).pop()?.replace(/^\.+/, '') ?? '';
  return name === '' ? null : name;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed %-escape is not worth failing a download over; the
    // composed fallback name takes over when this yields nothing usable.
    return '';
  }
}

/**
 * Fetch a generated document and hand it to the browser. The server names the
 * file (Content-Disposition); `fallbackName` is only reached when the blob
 * arrives without one, since an `<a download>` needs some name.
 *
 * `assertOk` BEFORE `blob()`, and that order is the point: a JSON 500 body
 * blobs perfectly well, and writing it to disk under a `.pdf` name is how a
 * correct refusal reached a user as a corrupt file.
 */
async function downloadFile(url: string, fallbackName: string, failure: string): Promise<void> {
  const res = await apiFetch(url);
  await assertOk(res, failure);
  const served = filenameFromDisposition(res.headers.get('Content-Disposition'));
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = served ?? fallbackName;
  a.click();
  URL.revokeObjectURL(objectUrl);
}

export function usePackDownload(request: PackDownloadRequest): PackDownload {
  const [downloading, setDownloading] = useState<PackDownloadFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { packType, from, to } = request;

  const download = async (format: PackDownloadFormat) => {
    setDownloading(format);
    setError(null);
    try {
      await downloadFile(
        `/api/accounting/packs/${packType}/${format}?from=${from}&to=${to}`,
        // Reached only when the response carries no Content-Disposition —
        // the company slug lives on the server side of this call, so a
        // client-composed name cannot carry it.
        `report-pack-${packType}-${from}-to-${to}.${format}`,
        `${format.toUpperCase()} generation failed`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to download report pack', { format, error: message });
      setError(message);
    } finally {
      setDownloading(null);
    }
  };

  return { downloading, error, download };
}
