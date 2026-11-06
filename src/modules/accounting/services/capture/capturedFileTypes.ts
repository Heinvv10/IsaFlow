/**
 * The MIME type a captured_documents.file_type names. Most writers store a short name ("pdf", "jpeg"); the email
 * mirror (imapMirrorIngest) stores the full type. Both must land on the same type. No imports, so the bank and report
 * modules can use it without pulling in capture's storage code.
 */
const MIME_BY_FILE_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  'application/pdf': 'application/pdf',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  png: 'image/png',
  'image/png': 'image/png',
  webp: 'image/webp',
  'image/webp': 'image/webp',
  tiff: 'image/tiff',
  'image/tiff': 'image/tiff',
};

/** The MIME type a captured_documents.file_type names, or null when it names none we know. */
export function mimeForCapturedFileType(fileType: string): string | null {
  return MIME_BY_FILE_TYPE[fileType.toLowerCase()] ?? null;
}
