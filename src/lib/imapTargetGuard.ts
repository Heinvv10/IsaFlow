/**
 * Where an IMAP mirror may connect (S-07e part B). The scan cron decrypts a
 * connection's stored mailbox password and presents it to `host:port`, and
 * shows the server's reply in `last_error`, so a host a tenant can point at the
 * server's own network is an SSRF probe and a credential sink. A connection's
 * host must be, and resolve only to, public addresses (the classification
 * safeFetch uses), and its port one an IMAP server listens on: 143 (STARTTLS /
 * plain) and 993 (implicit TLS). The settings pages default to 993 and offer no
 * other list.
 *
 * Checked when a connection is created and again right before each scan
 * connects, so a name that later resolves into private space is refused.
 * Named limit: ImapFlow resolves the name itself, so a sub-second DNS
 * rebinding between this lookup and its connect is not closed (as safeFetch).
 */
import { checkPublicHostname } from '@/lib/safeFetch';

export const ALLOWED_IMAP_PORTS: readonly number[] = [143, 993];

/** A DNS name (punycode for non-ASCII) or an IP literal: nothing a resolver or the IMAP client could read as more. */
const HOST_CHARS = /^[A-Za-z0-9._:-]+$/;

/** null when `host:port` may be connected to, else a message fit to show the user. */
export async function checkImapTarget(host: unknown, port: unknown): Promise<string | null> {
  if (typeof host !== 'string' || !host) return 'IMAP host is required';
  if (!HOST_CHARS.test(host)) return 'IMAP host is not allowed: not a valid host name';
  if (typeof port !== 'number' || !ALLOWED_IMAP_PORTS.includes(port)) {
    return `IMAP port must be ${ALLOWED_IMAP_PORTS.join(' or ')}`;
  }
  const reason = await checkPublicHostname(host);
  return reason ? `IMAP host is not allowed: ${reason}` : null;
}
