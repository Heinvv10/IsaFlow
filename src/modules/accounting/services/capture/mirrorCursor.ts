/**
 * A mirror connection's per-folder scan cursor (the last IMAP UID ingested),
 * shared by imapMirrorService and sentMirrorService.
 *
 * `scan_cursor` was app-writable until review round 5 of migration 946 (now only
 * migration_admin writes it), and an ops edit or a server whose UIDNEXT went
 * backwards can still leave anything in it. A cursor goes into the
 * IMAP `UID FETCH <cursor + 1>:*`; a value such as 1.5, -1 or 1e20 makes the server
 * answer BAD, the scan throws, and the connection is flipped to 'error'. So a
 * folder's cursor is used only when it is a positive safe integer; any other
 * value is logged and the folder is scanned as if it had none. That re-scan is
 * safe only because ingestion de-duplicates by content hash
 * (capturedDocumentHash.ts, in both mirrors), so it captures nothing twice.
 *
 * "Positive integer" means an IMAP number: 1..2^32-1 (RFC 3501 nz-number). The
 * highest UID that exists is UIDNEXT - 1, so when the mailbox reports its UIDNEXT a
 * cursor at or past it can never be reached by the mail that is there. It is
 * clamped to UIDNEXT - 1: nothing old is scanned and the next new message is
 * picked up. The caller writes the clamped value back (`clamped`), else the stored
 * value would hold the folder silent until UIDNEXT overtook it. A mailbox with
 * UIDNEXT 1 is empty: nothing is clamped, logged or written for it (the stored
 * cursor stays, and is clamped when mail arrives and UIDNEXT is above 1).
 *
 * Limits this does not remove: (1) a mailbox rebuilt on the server (a changed
 * UIDVALIDITY, which the cursor does not record) is not detected unless its UIDNEXT
 * fell below the cursor; then the cursor is clamped and the old mail is not
 * re-captured; (2) a wrong cursor between the real one and UIDNEXT - 1 (only a
 * migration_admin write can put one there now) skips the mail in that gap, which is
 * indistinguishable from a real one.
 */
import { log } from '@/lib/logger';

export type MirrorCursorKind = 'imap-mirror' | 'sent-mirror';

const MAX_IMAP_NUMBER = 0xffffffff;

export interface MirrorCursor {
  /** The UID to scan after; 0 scans the folder from its first message. */
  uid: number;
  /** True when `uid` differs from a valid stored cursor (clamped to UIDNEXT - 1): store it. */
  clamped: boolean;
}

export function readCursor(
  scanCursor: unknown,
  folder: string,
  ref: { id: string; kind: MirrorCursorKind },
  uidNext = 0,
): MirrorCursor {
  if (typeof scanCursor !== 'object' || scanCursor === null || Array.isArray(scanCursor)) {
    if (scanCursor !== undefined && scanCursor !== null) {
      log.warn('mirror scan_cursor is not an object; scanning from the start', { connectionId: ref.id, folder }, ref.kind);
    }
    return { uid: 0, clamped: false };
  }
  const value = (scanCursor as Record<string, unknown>)[folder];
  if (value === undefined || value === null) return { uid: 0, clamped: false };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_IMAP_NUMBER) {
    if (uidNext <= 0 || value < uidNext) return { uid: value, clamped: false };
    // UIDNEXT 1: an empty mailbox, with no UID 0 to clamp to. Scan it from the start (nothing is
    // there) and write nothing: clamping would store 0 and warn again on every tick.
    if (uidNext === 1) return { uid: 0, clamped: false };
    log.warn('mirror scan_cursor for a folder is at or past the mailbox UIDNEXT; clamped to UIDNEXT - 1',
      { connectionId: ref.id, folder, cursor: value, uidNext }, ref.kind);
    return { uid: uidNext - 1, clamped: true };
  }
  log.warn('mirror scan_cursor for a folder is not a positive IMAP number; scanning it from the start',
    { connectionId: ref.id, folder, cursorType: typeof value }, ref.kind);
  return { uid: 0, clamped: false };
}
