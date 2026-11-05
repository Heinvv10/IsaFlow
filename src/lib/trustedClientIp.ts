/**
 * The visitor's IP address for an audit or fraud record (invoice read receipts, admin and dispute records), from what
 * nginx guarantees.
 *
 * app.isaflow.co.za is Cloudflare -> nginx (nginx site `isaflow-combined`) -> the app. nginx has no real_ip module and
 * sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which APPENDS nginx's own TCP peer to whatever the client sent;
 * Cloudflare in turn appended the address that connected to IT. So behind Cloudflare the header reads
 *
 *     <whatever the client forged...>, <the visitor Cloudflare saw>, <Cloudflare's edge, appended by nginx>
 *
 * The leftmost entries are the client's to write (pentest H7/H8; `getClientIp` in rateLimit.ts documents the same), the
 * last is nginx's and unforgeable. Exactly ONE hop is peeled:
 *   - the last entry is nginx's peer. If it is NOT a Cloudflare edge, it is the visitor (a request that reached nginx
 *     without Cloudflare);
 *   - if it IS a Cloudflare edge, the visitor is Cloudflare's own CF-Connecting-IP (nginx passes it through; trusted
 *     ONLY from a Cloudflare peer, which overwrites any value the client sent), else the entry immediately left of the
 *     peer, whatever it is. Never further left: a visitor that itself egresses from a Cloudflare address (a Worker,
 *     WARP) is recorded as that address, and a forged entry left of it can never win.
 * The answer is validated with `net.isIP`; anything else is null, never text.
 *
 * `getClientIp` (rate limiting) deliberately keeps the LAST entry (a per-edge bucket is enough there). This is for
 * records that must name the person. CLOUDFLARE_RANGES is Cloudflare's published list (cloudflare.com/ips-v4, ips-v6),
 * checked against it on 2026-11-05; a range it adds later would make that edge read as a visitor until it is added.
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
export function trustedClientIpOf(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  cfConnectingIp?: string | string[] | undefined,
): string | null {
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (chain.length === 0) return normalise(remoteAddress);

  const peer = normalise(chain[chain.length - 1]); // nginx's own TCP peer: appended by nginx, never forged
  if (peer === null) return null;
  if (!isCloudflare(peer)) return peer; // no Cloudflare in front of this request: the peer is the visitor

  // Cloudflare is the peer: the visitor is what it says, else the one entry it appended. Not further left.
  const cf = normalise(Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp);
  if (cf !== null) return cf;
  return chain.length >= 2 ? normalise(chain[chain.length - 2]) : null;
}

export function trustedClientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>): string | null {
  return trustedClientIpOf(req.headers['x-forwarded-for'], req.socket.remoteAddress, req.headers['cf-connecting-ip']);
}
