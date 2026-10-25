/**
 * The size bounds on what a mirror scan reads from a tenant's mail server, shared by
 * imapMirrorService and sentMirrorService (S-07e part B). The server is the tenant's
 * own and the cron runs in the shared production process, so nothing it says about
 * sizes is trusted:
 *
 * - A message is fetched only when the server reports an RFC822.SIZE at or under
 *   MAX_MIRROR_MESSAGE_BYTES; a missing size is treated as too large.
 * - The bytes it then sends are counted as they arrive (ByteMeter): one server response
 *   (a line and its literals) may carry at most MAX_RESPONSE_BYTES, and while the scan
 *   lists envelopes (up to 50 of them are held) MAX_ENVELOPE_RESPONSE_BYTES. Past that
 *   the meter calls its `onOver`, which closes the client (mirrorScanGuard.ts): ImapFlow
 *   would otherwise buffer a literal of up to 1 GB whatever the size it reported.
 * - A fetched source longer than MAX_MIRROR_MESSAGE_BYTES is not parsed
 *   (mirrorImapFetch.ts), and the subject and address a scan writes are clipped to
 *   MAX_MIRROR_TEXT_CHARS (clipMirrorText).
 *
 * The meter counts what ImapFlow's protocol parser (its `streamer`) is given: the bytes
 * after TLS and after COMPRESS=DEFLATE inflation, so a compressed literal is counted at
 * its real size. `streamer` is ImapFlow's internal (1.3.x); without it the meter refuses
 * to start and the scan fails, rather than run unbounded.
 */
import type { ImapFlow } from 'imapflow';
import { MAX_FILE_SIZE } from './captureLimits';

/**
 * The largest message (RFC822.SIZE) a scan fetches: the capture pipeline's largest file,
 * as base64 (4/3) plus 64 KB for headers and the text part.
 */
export const MAX_MIRROR_MESSAGE_BYTES = Math.ceil((MAX_FILE_SIZE * 4) / 3) + 64 * 1024;

/** The most one server response may carry: a message at the cap, with room for a server's own size count. */
export const MAX_RESPONSE_BYTES = Math.ceil(MAX_MIRROR_MESSAGE_BYTES * 1.5);

/** The most one envelope-and-size response may carry while the scan lists messages (it holds up to 50). */
export const MAX_ENVELOPE_RESPONSE_BYTES = 1024 * 1024;

/** The longest subject, sender or recipient a scan writes. */
export const MAX_MIRROR_TEXT_CHARS = 500;

/** True when the server reported no size, or one over the cap: such a message is not fetched. */
export function isOversizedMessage(size: unknown): boolean {
  return typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > MAX_MIRROR_MESSAGE_BYTES;
}

/** `text` cut to MAX_MIRROR_TEXT_CHARS, or null. */
export function clipMirrorText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.length > MAX_MIRROR_TEXT_CHARS ? text.slice(0, MAX_MIRROR_TEXT_CHARS) : text;
}

interface Streamer {
  write: (chunk: unknown, ...rest: unknown[]) => boolean;
  push: (value: unknown) => boolean;
}

const meters = new WeakMap<ImapFlow, ByteMeter>();

/** Counts the bytes of each server response on `client` and calls `onOver` once when one passes its limit. */
export class ByteMeter {
  private used = 0;
  private limit = MAX_RESPONSE_BYTES;
  private tripped = false;

  constructor(client: ImapFlow, private readonly onOver: (bytes: number, limit: number) => void) {
    const streamer = (client as unknown as { streamer?: Partial<Streamer> }).streamer;
    if (!streamer || typeof streamer.write !== 'function' || typeof streamer.push !== 'function') {
      throw new Error('This IMAP client cannot be size-limited; the scan was not started');
    }
    const write = streamer.write.bind(streamer);
    const push = streamer.push.bind(streamer);
    // Every byte from the socket (or the inflater) reaches the parser through write();
    // push() hands ImapFlow one complete response, so the count restarts there.
    streamer.write = (chunk: unknown, ...rest: unknown[]) => {
      if (this.count(chunk)) return true; // over: dropped, and the client is being closed
      return write(chunk, ...rest);
    };
    streamer.push = (value: unknown) => {
      this.used = 0;
      return push(value);
    };
    meters.set(client, this);
  }

  /** Sets the per-response limit from now on. */
  setLimit(limit: number): void {
    this.limit = limit;
  }

  /** Adds `chunk`; true once a response has passed its limit (then and after). */
  private count(chunk: unknown): boolean {
    if (this.tripped) return true;
    this.used += Buffer.isBuffer(chunk) ? chunk.length : typeof chunk === 'string' ? Buffer.byteLength(chunk) : 0;
    if (this.used <= this.limit) return false;
    this.tripped = true;
    this.onOver(this.used, this.limit);
    return true;
  }
}

/** Sets the per-response limit on `client`'s meter, if it has one (every scan's client does: mirrorScanGuard.track). */
export function setResponseLimit(client: ImapFlow, limit: number): void {
  meters.get(client)?.setLimit(limit);
}
