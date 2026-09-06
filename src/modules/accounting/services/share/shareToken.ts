/**
 * Share-link token primitives.
 *
 * 256 bits of CSPRNG output, base64url, 43 characters. Guessing one is not a
 * threat model we mitigate with rate limits — it is infeasible — but the shape
 * check exists so that a malformed token is rejected BEFORE it reaches a query,
 * making the 404 for an unknown link unconditional and constant-shaped.
 *
 * Only the sha256 of the token is ever persisted (share_links.token_hash), so
 * a database read does not yield a working link. There is no HMAC and no
 * embedded expiry: expiry and revocation are columns, checked server-side on
 * every view, so withdrawing a link is immediate rather than waiting out a TTL.
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function mintShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isShareTokenShape(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}
