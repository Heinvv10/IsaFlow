/**
 * Where an IMAP mirror may connect (S-07e part B). The scan cron decrypts a
 * connection's stored mailbox password and presents it to `host:port`, and
 * shows the failure in `last_error`, so a host a tenant can point at the
 * server's own network is an SSRF probe and a credential sink. A connection's
 * host must be, and resolve only to, public addresses (the classification
 * safeFetch uses), and its port one an IMAP server listens on: 143 (STARTTLS /
 * plain) and 993 (implicit TLS). The settings pages default to 993 and offer no
 * other list.
 *
 * Checked when a connection is created and again right before each scan
 * connects, so a name that later resolves into private space is refused.
 *
 * The scan connects to the address that was vetted, not to the name: the
 * result carries it, with the name as the TLS `servername` (SNI and the
 * certificate check), so the client never resolves the name a second time. A
 * name whose DNS answers public once and private the next time (rebinding)
 * therefore reaches only the public address.
 *
 * The user sees only that the address is not allowed (or, when DNS gave no
 * answer at all, that it could not be resolved: a typo or an outage, not a
 * policy); which address it resolved to is logged, never returned (it would
 * map the internal DNS). The result says, for the scan only, when the failure
 * was that DNS gave no answer (`transient`): the scan then retries the
 * connection next interval instead of disabling it; the tenant still sees the
 * one message.
 */
import net from 'node:net';
import { DnsResolutionError, resolvePublicHostname } from '@/lib/safeFetch';
import { log } from '@/lib/logger';

export const ALLOWED_IMAP_PORTS: readonly number[] = [143, 993];

// One message for a refused and an unresolvable host: two would tell a tenant which internal names resolve. The log keeps the cause.
export const IMAP_HOST_REFUSED = 'This mail server address is not allowed or could not be resolved';
export const IMAP_PORT_REFUSED = `Only ports ${ALLOWED_IMAP_PORTS.join(' and ')} are supported`;

/** A DNS name (punycode for non-ASCII) or an IP literal: nothing a resolver or the IMAP client could read as more. */
const HOST_CHARS = /^[A-Za-z0-9._:-]+$/;

export type ImapTarget =
  /** `address` to connect to; `servername` the host name for TLS (absent when the host is an IP literal). */
  | { ok: true; address: string; servername?: string }
  /** `message` is fit to show the user; `transient` (never shown) when DNS gave no answer, not when it refused the answer. */
  | { ok: false; message: string; transient?: true };

/** What a scan throws when its target check failed; `transient` as in ImapTarget. */
export class ImapTargetError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = 'ImapTargetError';
  }
}

const refuse = (message: string, detail: string, host: unknown, port: unknown, transient = false): ImapTarget => {
  log.warn('IMAP target refused', { host: typeof host === 'string' ? host.slice(0, 255) : typeof host, port, detail, transient }, 'imap-target-guard');
  return transient ? { ok: false, message, transient } : { ok: false, message };
};

export async function checkImapTarget(host: unknown, port: unknown): Promise<ImapTarget> {
  if (typeof host !== 'string' || !host) return { ok: false, message: 'IMAP host is required' };
  if (!HOST_CHARS.test(host)) return refuse(IMAP_HOST_REFUSED, 'not a valid host name', host, port);
  if (typeof port !== 'number' || !ALLOWED_IMAP_PORTS.includes(port)) {
    return refuse(IMAP_PORT_REFUSED, 'port not allowed', host, port);
  }
  try {
    const address = await resolvePublicHostname(host);
    return net.isIP(host) ? { ok: true, address } : { ok: true, address, servername: host };
  } catch (err) {
    return refuse(IMAP_HOST_REFUSED, err instanceof Error ? err.message : 'invalid host', host, port, err instanceof DnsResolutionError);
  }
}
