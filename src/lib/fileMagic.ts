/**
 * Magic-byte file-type validation — WS-3 (pentest H5/H6/M15).
 *
 * The Content-Type header, a data-URL prefix, and formidable's `file.mimetype`
 * are all client-controlled and trivially spoofable. Before storing or serving
 * an uploaded file, decode it and confirm the real leading bytes match the
 * claimed MIME so an HTML/SVG/executable payload can't masquerade as an image.
 */

/** Detect a MIME type from a buffer's leading bytes, or null if unrecognised. */
export function detectMimeFromMagic(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  const hex = buffer.subarray(0, 12).toString('hex').toUpperCase();
  if (hex.startsWith('FFD8FF')) return 'image/jpeg';
  if (hex.startsWith('89504E47')) return 'image/png';
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return 'image/gif';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('504B0304') || hex.startsWith('504B0506') || hex.startsWith('504B0708')) {
    return 'application/zip'; // also docx/xlsx/odt containers
  }
  // WebP: RIFF????WEBP
  if (
    hex.startsWith('52494646') &&
    buffer.length >= 12 &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  // TIFF: little-endian (II) or big-endian (MM)
  if (hex.startsWith('49492A00') || hex.startsWith('4D4D002A')) return 'image/tiff';
  return null;
}

const OOXML_ZIP_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
]);

/** True if `buffer`'s real type is compatible with the `claimedMime`. */
export function magicBytesMatchMime(buffer: Buffer, claimedMime: string): boolean {
  const detected = detectMimeFromMagic(buffer);
  if (!detected) return false;
  if (detected === claimedMime) return true;
  // Office Open XML files (docx/xlsx/pptx) are ZIP containers on disk.
  if (detected === 'application/zip' && OOXML_ZIP_MIMES.has(claimedMime)) return true;
  // image/jpg is a non-standard alias some browsers and formidable emit for JPEG files.
  if (detected === 'image/jpeg' && claimedMime === 'image/jpg') return true;
  return false;
}

/**
 * Decode an upload payload that is either a raw base64 string or a
 * `data:<mime>;base64,<payload>` URL. Returns null for empty/undecodable input.
 */
export function decodeUploadPayload(input: string): Buffer | null {
  if (!input) return null;
  let b64 = input;
  if (input.startsWith('data:')) {
    const comma = input.indexOf(',');
    if (comma === -1) return null;
    b64 = input.slice(comma + 1);
  }
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
