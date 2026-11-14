/**
 * Policy for the admin-supplied health-alert webhook URL: https only, and the host must not be a
 * literal local/private address. Literal-host check only (no DNS): delivery additionally goes
 * through safeFetch, which re-resolves the host and refuses private/reserved addresses.
 */

function ipv4Private(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function ipv6Private(host: string): boolean {
  if (host === '::' || host === '::1') return true;
  const first = parseInt(host.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;  // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;  // fe80::/10 link-local
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);  // URL normalises ::ffff:a.b.c.d to hex
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    return ipv4Private(hi >> 8, hi & 0xff);
  }
  return false;
}

/** The reason a webhook URL is refused, or null when it is acceptable. */
export function webhookUrlRefusal(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'Webhook URL must be a valid https:// address'; }
  if (url.protocol !== 'https:') return 'Webhook URL must be a valid https:// address';
  const host = url.hostname.toLowerCase();
  const refused = 'Webhook URL must point to a public host, not localhost or a private address';
  if (host === 'localhost' || host.endsWith('.localhost')) return refused;
  if (host.startsWith('[')) return ipv6Private(host.slice(1, -1)) ? refused : null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 && ipv4Private(Number(v4[1]), Number(v4[2]))) return refused;
  return null;
}
