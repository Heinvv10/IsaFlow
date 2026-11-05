/**
 * The visitor's IP address for an audit or fraud record (invoice read receipts), from what nginx guarantees.
 *
 * app.isaflow.co.za is Cloudflare -> nginx (scripts/ nginx site `isaflow-combined`) -> the app. nginx has no real_ip
 * module and sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which APPENDS nginx's own TCP peer to whatever the
 * client sent. Cloudflare in turn appended the address that connected to IT. So behind Cloudflare the header reads
 *
 *     <whatever the client forged...>, <the visitor Cloudflare saw>, <Cloudflare's edge, appended by nginx>
 *
 * The LEFTMOST entry is the client's to write (pentest H7/H8; `getClientIp` in rateLimit.ts documents the same), the
 * last is nginx's and unforgeable, and the visitor is the right-most entry that is NOT a Cloudflare address: walk in
 * from the right past Cloudflare's published ranges. A request that reached nginx without Cloudflare ends in its real
 * peer, which is not in those ranges and so is the answer. The answer is validated with `net.isIP`; anything else is
 * null, never text (a stored garbage value could suppress or poison the record).
 *
 * `getClientIp` (rate limiting) deliberately keeps the LAST entry (a per-edge bucket is enough there). This is for
 * records that must name the person. CLOUDFLARE_RANGES is Cloudflare's published list (cloudflare.com/ips); a range it
 * adds later would make its edge read as the visitor until it is added here.
 */

import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'http';

const CLOUDFLARE_RANGES: ReadonlyArray<readonly [string, number, 'ipv4' | 'ipv6']> = [
  ['173.245.48.0', 20, 'ipv4'], ['103.21.244.0', 22, 'ipv4'], ['103.22.200.0', 22, 'ipv4'], ['103.31.4.0', 22, 'ipv4'],
  ['141.101.64.0', 18, 'ipv4'], ['108.162.192.0', 18, 'ipv4'], ['190.93.240.0', 20, 'ipv4'], ['188.114.96.0', 20, 'ipv4'],
  ['197.234.240.0', 22, 'ipv4'], ['198.41.128.0', 17, 'ipv4'], ['162.158.0.0', 15, 'ipv4'], ['104.16.0.0', 13, 'ipv4'],
  ['104.24.0.0', 14, 'ipv4'], ['172.64.0.0', 13, 'ipv4'], ['131.0.72.0', 22, 'ipv4'],
  ['2400:cb00::', 32, 'ipv6'], ['2606:4700::', 32, 'ipv6'], ['2803:f800::', 32, 'ipv6'], ['2405:b500::', 32, 'ipv6'],
  ['2405:8100::', 32, 'ipv6'], ['2a06:98c0::', 29, 'ipv6'], ['2c0f:f248::', 32, 'ipv6'],
];

const cloudflare = new BlockList();
for (const [net, prefix, family] of CLOUDFLARE_RANGES) cloudflare.addSubnet(net, prefix, family);

/** A valid address in its plain form (an IPv4-mapped IPv6 address becomes the IPv4 address), or null. */
function normalise(raw: string | undefined): string | null {
  const text = (raw ?? '').trim();
  const plain = text.toLowerCase().startsWith('::ffff:') && isIP(text.slice(7)) === 4 ? text.slice(7) : text;
  return isIP(plain) === 0 ? null : plain;
}

function isCloudflare(address: string): boolean {
  return cloudflare.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** For a caller that holds the headers and the socket address apart (the analytics tracker). */
export function trustedClientIpOf(forwardedFor: string | string[] | undefined, remoteAddress: string | undefined): string | null {
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (chain.length === 0) return normalise(remoteAddress);

  // From the right: nginx's own peer first (never forged), then past each Cloudflare hop to the visitor.
  for (let i = chain.length - 1; i >= 0; i--) {
    const address = normalise(chain[i]);
    if (address === null) return null; // the entry that would be the answer is not an address
    if (!isCloudflare(address)) return address;
  }
  return null; // only Cloudflare addresses: no visitor was named
}

export function trustedClientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>): string | null {
  return trustedClientIpOf(req.headers['x-forwarded-for'], req.socket.remoteAddress);
}
