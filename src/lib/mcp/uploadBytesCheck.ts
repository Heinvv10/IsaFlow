/**
 * The byte checks of the MCP upload path (PUT /api/mcp/uploads/<token> and finalize_uploads), and only that path:
 * exact declared size, the declared sha256, magic bytes matching the declared mime type (the shared fileMagic rule),
 * and a COMPLETE file of that type. The last is what stops a polyglot (a PDF header followed by HTML) that passes a
 * magic-byte check: a PDF must END with %%EOF (in its last 1024 bytes, followed only by whitespace or NUL padding). A PNG must CONTAIN its IEND chunk and a JPEG its
 * end-of-image marker FFD9 (a truncated image is refused), but content AFTER them is allowed: phone "motion photos"
 * append an MP4 after FFD9 and some cameras pad after the image, and those are genuine receipts (attach_document takes
 * them). The bytes are stored and served as the declared type only. OOXML (DOCX / XLSX) is checked by magic bytes
 * only. Other upload routes keep fileMagic as it is.
 */
import { createHash } from 'crypto';
import { magicBytesMatchMime } from '@/lib/fileMagic';

const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex');
const PDF_TAIL = 1024;
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const PDF_END = /%%EOF[\s\0]*$/;

/** True when `bytes` hold a whole file of `mime` (mimes without a rule pass). */
export function uploadStructureComplete(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case 'application/pdf':
      // %%EOF in the last 1024 bytes, followed by nothing but whitespace / NUL padding to the end of the file.
      return PDF_END.test(bytes.subarray(Math.max(0, bytes.length - PDF_TAIL)).toString('latin1'));
    case 'image/png':
      return bytes.includes(PNG_IEND, 8);
    case 'image/jpeg':
    case 'image/jpg':
      return bytes.includes(JPEG_EOI, 2);
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
    return `the file is not a complete ${d.mimeType} file (truncated${d.mimeType === 'application/pdf' ? ', or other content after its end' : ''})`;
  }
  return null;
}
