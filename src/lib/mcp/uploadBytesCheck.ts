/**
 * The byte checks of the MCP upload path (PUT /api/mcp/uploads/<token> and finalize_uploads), and only that path:
 * exact declared size, the declared sha256, magic bytes matching the declared mime type (the shared fileMagic rule),
 * and a COMPLETE file of that type. The last is what stops a polyglot (a PDF header followed by HTML) that passes a
 * magic-byte check: a PDF must carry %%EOF in its last 1024 bytes, a PNG must end with its IEND chunk, a JPEG with its
 * end-of-image marker FFD9. OOXML (DOCX / XLSX) is checked by magic bytes only. Other upload routes keep fileMagic as
 * it is.
 */
import { createHash } from 'crypto';
import { magicBytesMatchMime } from '@/lib/fileMagic';

const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex');
const PDF_EOF = Buffer.from('%%EOF', 'latin1');
const PDF_TAIL = 1024;

/** True when `bytes` end the way a whole file of `mime` ends (mimes without a rule pass). */
export function uploadStructureComplete(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case 'application/pdf':
      return bytes.subarray(Math.max(0, bytes.length - PDF_TAIL)).includes(PDF_EOF);
    case 'image/png':
      return bytes.length >= PNG_IEND.length && bytes.subarray(bytes.length - PNG_IEND.length).equals(PNG_IEND);
    case 'image/jpeg':
    case 'image/jpg':
      return bytes.length >= 2 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    default:
      return true;
  }
}

export interface UploadDeclaration {
  declaredSize: number;
  sha256: string;
  mimeType: string;
}

/** Why `bytes` are not the declared file, or null when they are. */
export function uploadBytesRefusal(bytes: Buffer, d: UploadDeclaration): string | null {
  if (bytes.length === 0) return 'no bytes were uploaded';
  if (bytes.length !== d.declaredSize) return `the body is ${bytes.length} bytes; ${d.declaredSize} were declared`;
  if (createHash('sha256').update(bytes).digest('hex') !== d.sha256) return 'the bytes do not match the declared sha256';
  if (!magicBytesMatchMime(bytes, d.mimeType)) return `the file contents do not match mime_type ${d.mimeType}`;
  if (!uploadStructureComplete(bytes, d.mimeType)) {
    return `the file is not a complete ${d.mimeType} file (truncated, or other content after its end)`;
  }
  return null;
}
