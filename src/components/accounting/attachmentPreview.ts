/**
 * What the attachment viewer may show in place, and the blob it shows it from.
 *
 * Stored attachments are base64 data URLs. Chrome refuses a data: URL as a top-level page and frames one unreliably,
 * so the viewer decodes it to a Blob and shows a blob: URL (img-src and frame-src allow blob:, see
 * config/securityHeaders.js).
 *
 * SECURITY: only the inert types below are previewed. This is a subset of SAFE_HREF (bankTxAttachmentHelpers), minus
 * tiff, which browsers do not render. Never widen it to svg/html/xml: a blob: frame of those runs script. https links
 * are not previewed either: the CSP will not frame another origin, so they keep their plain link.
 */

export type PreviewKind = 'image' | 'pdf' | 'none';

const PREVIEWABLE = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,/;

export function previewKind(fileUrl: string): PreviewKind {
  const mime = PREVIEWABLE.exec(fileUrl)?.[1];
  if (!mime) return 'none';
  return mime === 'application/pdf' ? 'pdf' : 'image';
}

/** Decode a previewable data URL into a Blob of its own type; null for anything else or bad base64. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = PREVIEWABLE.exec(dataUrl);
  if (!match) return null;
  try {
    const binary = atob(dataUrl.slice(match[0].length));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1] });
  } catch {
    // atob throws on malformed base64: there is nothing to show, and the viewer says so.
    return null;
  }
}
