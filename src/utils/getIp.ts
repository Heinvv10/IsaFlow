import type { NextApiRequest } from 'next';
import { getClientIp } from '@/lib/rateLimit';

/**
 * Extract client IP from request headers, using the trusted last-hop XFF entry.
 * Returns null for backwards compatibility when no IP can be determined.
 */
export function getIp(req: NextApiRequest): string | null {
  const ip = getClientIp(req);
  return ip === 'unknown' ? null : ip;
}
