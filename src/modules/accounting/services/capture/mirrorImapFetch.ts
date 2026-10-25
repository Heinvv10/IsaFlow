/**
 * The IMAP calls a mirror scan makes against a selected mailbox, shared by
 * imapMirrorService and sentMirrorService. The scan cursor is a UID, so every
 * range and every message number here is a UID: ImapFlow sends `UID FETCH`
 * only when `{ uid: true }` is in its OPTIONS argument. `uid: true` in the
 * query object merely asks for the UID attribute in the answer, and a FETCH
 * without the option reads the number as a message sequence number, which
 * differs from the UID as soon as one message has been expunged.
 */
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { log } from '@/lib/logger';
import { MAX_ENVELOPE_RESPONSE_BYTES, MAX_MIRROR_MESSAGE_BYTES, MAX_RESPONSE_BYTES, setResponseLimit } from './mirrorScanLimits';

const BY_UID = { uid: true } as const;

/** Messages past the cursor that a scan looks at in one pass. */
const SCAN_BATCH = 50;

/** The largest number IMAP has (RFC 3501 nz-number): a UID outside 1..this is the server's mistake, not a message. */
const MAX_IMAP_NUMBER = 0xffffffff;

/** The mailbox's UIDNEXT, or 0 when the server did not report one. */
export function mailboxUidNext(client: ImapFlow): number {
  const mbox = client.mailbox;
  if (typeof mbox !== 'object' || !mbox || !('uidNext' in mbox)) return 0;
  const n = Number((mbox as { uidNext?: number }).uidNext ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Envelope + size of up to SCAN_BATCH messages with a UID above `cursorUid`. `N:*` on a
 * mailbox whose highest UID is below N answers with the last message (RFC 3501 6.4.8),
 * so a message at or below the cursor is dropped here rather than scanned again. A UID that is
 * not an integer in 1..2^32-1 is dropped too: it would never be ingested, and written as a
 * cursor it would be one the next scan rejects. Each answer may carry at most
 * MAX_ENVELOPE_RESPONSE_BYTES while the list is read (mirrorScanLimits.ts): up to
 * SCAN_BATCH of them are held.
 */
export async function fetchNewMessages(client: ImapFlow, cursorUid: number): Promise<FetchMessageObject[]> {
  const range = cursorUid > 0 ? `${cursorUid + 1}:*` : '1:*';
  const messages: FetchMessageObject[] = [];
  setResponseLimit(client, MAX_ENVELOPE_RESPONSE_BYTES);
  try {
    for await (const msg of client.fetch(range, { uid: true, envelope: true, size: true }, BY_UID)) {
      const uid = Number(msg.uid);
      if (!Number.isInteger(uid) || uid <= cursorUid || uid > MAX_IMAP_NUMBER) continue;
      messages.push(msg);
      if (messages.length >= SCAN_BATCH) break;
    }
  } finally {
    setResponseLimit(client, MAX_RESPONSE_BYTES);
  }
  return messages;
}

/**
 * The raw source of the message with this UID, or null when the server has none, answers with
 * another message, or sends more than MAX_MIRROR_MESSAGE_BYTES (it reported a smaller size:
 * the source is not handed to the parser).
 */
export async function fetchSourceByUid(client: ImapFlow, uid: number): Promise<Buffer | null> {
  const full = await client.fetchOne(String(uid), { source: true, uid: true }, BY_UID);
  if (!full || !full.source || Number(full.uid) !== uid) return null;
  if (full.source.length > MAX_MIRROR_MESSAGE_BYTES) {
    log.warn('mirror message source over the size cap; not parsed', { uid, bytes: full.source.length }, 'imap-mirror');
    return null;
  }
  return full.source;
}
