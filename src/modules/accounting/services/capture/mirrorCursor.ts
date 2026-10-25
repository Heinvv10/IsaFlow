/**
 * A mirror connection's per-folder scan cursor (the last IMAP UID ingested),
 * shared by imapMirrorService and sentMirrorService.
 *
 * `scan_cursor` is a column the app pool may write (migration 946: it is a scan
 * stamp), so a forged claim can put anything in it. A cursor goes into the
 * IMAP `FETCH <cursor + 1>:*`; a value such as 1.5, -1 or 1e20 makes the server
 * answer BAD, the scan throws, and the connection is flipped to 'error'. So a
 * folder's cursor is used only when it is a positive safe integer; any other
 * value is logged and the folder is scanned as if it had none (ingestion
 * de-duplicates by content hash, so a re-scan captures nothing twice).
 */
import { log } from '@/lib/logger';

export type MirrorCursorKind = 'imap-mirror' | 'sent-mirror';

export function readCursorUid(
  scanCursor: unknown,
  folder: string,
  ref: { id: string; kind: MirrorCursorKind },
): number {
  if (typeof scanCursor !== 'object' || scanCursor === null || Array.isArray(scanCursor)) {
    if (scanCursor !== undefined && scanCursor !== null) {
      log.warn('mirror scan_cursor is not an object; scanning from the start', { connectionId: ref.id, folder }, ref.kind);
    }
    return 0;
  }
  const value = (scanCursor as Record<string, unknown>)[folder];
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  log.warn('mirror scan_cursor for a folder is not a positive integer; scanning it from the start',
    { connectionId: ref.id, folder, cursorType: typeof value }, ref.kind);
  return 0;
}
