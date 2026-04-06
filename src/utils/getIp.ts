import type { NextApiRequest } from 'next';

/** Extract client IP from request headers, preferring X-Forwarded-For */
export function getIp(req: NextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}
