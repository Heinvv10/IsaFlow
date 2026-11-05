/**
 * What the attachment viewer may show in place, and the blob it shows it from.
 *
 * Stored attachments are base64 data URLs. Chrome refuses a data: URL as a top-level page and frames one unreliably,
 * so the viewer decodes it to a Blob and shows a blob: URL (img-src and frame-src allow blob:, see
 * config/securityHeaders.js).
 *
 * SECURITY: only the inert types below are ever given to a blob. Never widen them to svg/html/xml: a blob: frame of
 * those runs script. tiff is left out because browsers do not render it. https links are not previewed: the CSP will
 * not frame another origin, so they keep their plain link.
 *
 * A row typed application/octet-stream is read from its first bytes. The email mirror's full-MIME file_type used to
 * miss captureBankTxAttachService's map, so stored rows carry that label over a real PDF or image. The bytes can only
 * select one of the inert types: a file that merely starts like a PDF still goes to the PDF viewer, never an HTML
 * renderer.
 */

export type PreviewKind = 'image' | 'pdf' | 'none';

const TYPED = /^data:(image\/(?:jpe?g|png|webp)|application\/pdf);base64,/;
const UNTYPED = /^data:application\/octet-stream;base64,/;
/** 16 base64 characters decode to the 12 bytes the longest signature below needs. */
const SNIFF_CHARS = 16;

function sniffMime(base64: string): string | null {
  let head: string;
  try {
    head = atob(base64.slice(0, SNIFF_CHARS));
  } catch {
    // Malformed base64: there is nothing to identify, and the viewer says so.
    return null;
  }
  if (head.startsWith('%PDF-')) return 'application/pdf';
  if (head.startsWith('\xFF\xD8\xFF')) return 'image/jpeg';
  if (head.startsWith('\x89PNG\r\n\x1A\n')) return 'image/png';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The inert MIME type this data URL may be shown as, and where its base64 starts; null when it may not be shown. */
function resolve(fileUrl: string): { mime: string; start: number } | null {
  const typed = TYPED.exec(fileUrl);
  if (typed) return { mime: typed[1]!, start: typed[0].length };
  const untyped = UNTYPED.exec(fileUrl);
  if (!untyped) return null;
  const start = untyped[0].length;
  const mime = sniffMime(fileUrl.slice(start, start + SNIFF_CHARS));
  return mime ? { mime, start } : null;
}

export function previewKind(fileUrl: string): PreviewKind {
  const found = resolve(fileUrl);
  if (!found) return 'none';
  return found.mime === 'application/pdf' ? 'pdf' : 'image';
}

/** Decode a previewable data URL into a Blob of its own type; null for anything else or bad base64. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const found = resolve(dataUrl);
  if (!found) return null;
  try {
    const binary = atob(dataUrl.slice(found.start));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: found.mime });
  } catch {
    // atob throws on malformed base64: there is nothing to show, and the viewer says so.
    return null;
  }
}
