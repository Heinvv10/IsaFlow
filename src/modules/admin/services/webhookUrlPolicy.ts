/**
 * Policy for the admin-supplied health-alert webhook URL: https only, and the host must not be a
 * literal local/private address. Literal-host check only (no DNS): delivery additionally goes
 * through safeFetch, which re-resolves the host and refuses private/reserved addresses. IP
 * literals use safeFetch's own ranges (ipReason), so the two cannot drift apart.
 */
import net from 'node:net';
import { ipReason } from '@/lib/safeFetch';

const NOT_HTTPS = 'Webhook URL must be a valid https:// address';
const NOT_PUBLIC = 'Webhook URL must point to a public host, not localhost or a private address';

/** The reason a webhook URL is refused, or null when it is acceptable. */
export function webhookUrlRefusal(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return NOT_HTTPS; }
  if (url.protocol !== 'https:') return NOT_HTTPS;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return NOT_PUBLIC;
  if (net.isIP(host) !== 0 && ipReason(host)) return NOT_PUBLIC;
  return null;
}
