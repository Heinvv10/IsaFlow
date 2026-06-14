/**
 * SSRF-safe outbound fetch — WS-1 (pentest H2 webhook SSRF, M5 sage-pull SSRF).
 *
 * Any time the server fetches a URL that a user (or a tenant config row) can
 * influence, route it through `safeFetch` / validate it with `assertPublicUrl`.
 *
 * Defence model (layered):
 *  1. Reject non-https (unless allowHttp) and non-allowlisted hosts up front.
 *  2. For IP-literal hosts, block every reserved range directly.
 *  3. For DNS hosts, resolve and block if ANY resolved address is reserved —
 *     re-validated on every fetch, which closes the "validated only at create
 *     time" gap and catches DNS-rebinding-to-private.
 *  4. redirect: 'manual' so a 3xx can't bounce the request into private space.
 *
 * Residual: a sub-second TOCTOU between our lookup() and the kernel resolver used
 * by fetch() remains (full closure needs a pinned-IP dispatcher; undici is not a
 * dependency here). The re-validate-every-fetch + manual-redirect posture makes
 * the practical window negligible for the webhook/sage threat model.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface SafeFetchOptions {
  /** Permit http:// (default: https only). */
  allowHttp?: boolean;
  /** If set, the hostname must equal or be a dot-subdomain of one of these. */
  allowHosts?: string[];
  /** Abort after this many ms (default 5000). */
  timeoutMs?: number;
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function reasonV4(ip: string): string | null {
  const n = v4ToInt(ip);
  if (n === null) return 'invalid IPv4';
  const inRange = (base: string, bits: number): boolean => {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  if (inRange('0.0.0.0', 8)) return 'unspecified/this-host (0.0.0.0/8)';
  if (inRange('10.0.0.0', 8)) return 'private (10.0.0.0/8)';
  if (inRange('100.64.0.0', 10)) return 'CGNAT (100.64.0.0/10)';
  if (inRange('127.0.0.0', 8)) return 'loopback (127.0.0.0/8)';
  if (inRange('169.254.0.0', 16)) return 'link-local/metadata (169.254.0.0/16)';
  if (inRange('172.16.0.0', 12)) return 'private (172.16.0.0/12)';
  if (inRange('192.0.0.0', 24)) return 'IETF protocol (192.0.0.0/24)';
  if (inRange('192.0.2.0', 24)) return 'TEST-NET-1 (192.0.2.0/24)';
  if (inRange('192.168.0.0', 16)) return 'private (192.168.0.0/16)';
  if (inRange('198.18.0.0', 15)) return 'benchmarking (198.18.0.0/15)';
  if (inRange('198.51.100.0', 24)) return 'TEST-NET-2 (198.51.100.0/24)';
  if (inRange('203.0.113.0', 24)) return 'TEST-NET-3 (203.0.113.0/24)';
  if (inRange('224.0.0.0', 4)) return 'multicast (224.0.0.0/4)';
  if (inRange('240.0.0.0', 4)) return 'reserved (240.0.0.0/4)';
  return null;
}

/** Expand any IPv6 text form to its 8 hextets (numbers). Handles `::` compression
 *  and an embedded dotted-quad tail. Returns null if it can't be parsed. */
function expandV6(ipRaw: string): number[] | null {
  let s = ipRaw.toLowerCase();
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct); // drop zone id (fe80::1%eth0)
  // Convert an embedded dotted-quad tail (::ffff:1.2.3.4) into two hex groups.
  const dm = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dm) {
    const v4 = v4ToInt(dm[2]!);
    if (v4 === null) return null;
    s = `${dm[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let parts: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    parts = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (parts.length !== 8) return null;
  const nums = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return nums.some((x) => Number.isNaN(x)) ? null : nums;
}

function embeddedV4(h: number[]): string {
  return `${(h[6]! >> 8) & 0xff}.${h[6]! & 0xff}.${(h[7]! >> 8) & 0xff}.${h[7]! & 0xff}`;
}

function reasonV6(ip: string): string | null {
  const h = expandV6(ip);
  if (!h) return 'invalid IPv6';
  const zeroTo4 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible incl. ::1/:: (::/96) — validate the
  // embedded v4. new URL() canonicalizes these to hex (::ffff:7f00:1), so never regex the tail.
  if (zeroTo4 && (h[5] === 0xffff || h[5] === 0)) return reasonV4(embeddedV4(h));
  // NAT64 well-known prefix 64:ff9b::/96 — also wraps a v4.
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return reasonV4(embeddedV4(h));
  }
  if ((h[0]! & 0xfe00) === 0xfc00) return 'unique-local (fc00::/7)';
  if ((h[0]! & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((h[0]! & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  if (h[0] === 0x2002) return '6to4 (2002::/16)';
  if (h[0] === 0x2001 && h[1] === 0) return 'Teredo (2001::/32)';
  return null;
}

/** Returns a human-readable reason if `ip` is a non-public address, else null. */
export function ipReason(ip: string): string | null {
  const fam = net.isIP(ip);
  if (fam === 4) return reasonV4(ip);
  if (fam === 6) return reasonV6(ip);
  return 'not an IP address';
}

function hostAllowed(hostname: string, allowHosts: string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return allowHosts.some((a) => {
    const base = a.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    return h === base || h.endsWith('.' + base);
  });
}

/** Throws SsrfError unless `rawUrl` is safe to fetch from the server. */
export async function assertPublicUrl(rawUrl: string, opts: SafeFetchOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('invalid URL');
  }

  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new SsrfError(`scheme not allowed: ${url.protocol}`);
  }

  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

  if (opts.allowHosts && !hostAllowed(hostname, opts.allowHosts)) {
    throw new SsrfError(`host not allowlisted: ${hostname}`);
  }

  // IP literal → validate directly, no DNS.
  if (net.isIP(hostname) !== 0) {
    const r = ipReason(hostname);
    if (r) throw new SsrfError(`blocked address ${hostname}: ${r}`);
    return;
  }

  // DNS host → block if ANY resolved address is reserved (rebinding defence).
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfError(`DNS resolution failed for ${hostname}`);
  }
  if (!addrs.length) throw new SsrfError(`no DNS records for ${hostname}`);
  for (const a of addrs) {
    const r = ipReason(a.address);
    if (r) throw new SsrfError(`${hostname} resolves to blocked address ${a.address}: ${r}`);
  }
}

/** Non-throwing variant for request validation. Returns null when safe, else the reason. */
export async function checkPublicUrl(rawUrl: string, opts?: SafeFetchOptions): Promise<string | null> {
  try {
    await assertPublicUrl(rawUrl, opts);
    return null;
  } catch (err) {
    return err instanceof SsrfError ? err.message : 'invalid URL';
  }
}

/** fetch() that first proves the (re-resolved) target is public; never auto-follows redirects. */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  await assertPublicUrl(rawUrl, opts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    return await fetch(rawUrl, { ...init, redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
