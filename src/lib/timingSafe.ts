/**
 * Constant-time secret comparison — WS-4 (pentest M2).
 *
 * Plain `a !== b` on a secret can leak its length and a matching prefix through
 * response timing. Use this for header/secret checks (cron, inbound-email, etc.)
 * so they match the timing-safe pattern already used by the Paystack/CSRF checks.
 */
import { timingSafeEqual } from 'crypto';

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // Length is not secret here, and timingSafeEqual requires equal-length buffers.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
