/**
 * Self-authenticating upload tokens for PUT /api/mcp/uploads/<token>.
 *
 * A token is 16 random bytes followed by the first 16 bytes of HMAC-SHA256(key, those random bytes), base64url:
 * 43 characters. The route verifies the tag in process, with a constant-time compare, before any rate limiter or
 * query, so a forged or tampered token costs nothing shared and can deny nothing. Only the sha256 of the whole token
 * is stored (token_hash), as before.
 *
 * The key is derived from the server's existing JWT_SECRET for this purpose only (the budgetTemplateSignature /
 * impersonationAssurance pattern): no new secret. Without JWT_SECRET no token is minted (create_upload_urls refuses)
 * and none verifies (the route answers 404): never an unkeyed token. Rotating JWT_SECRET invalidates outstanding urls
 * (they live 30 minutes and fail closed).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

const PURPOSE = 'isaflow:mcp-upload-token:v1';
const RANDOM_BYTES = 16;
const TAG_BYTES = 16;
const TOKEN_BYTES = RANDOM_BYTES + TAG_BYTES;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function key(): Buffer | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

function tag(k: Buffer, random: Buffer): Buffer {
  return createHmac('sha256', k).update(random).digest().subarray(0, TAG_BYTES);
}

/** Whether tokens can be minted and verified in this process (JWT_SECRET is set). */
export function uploadTokenKeyAvailable(): boolean {
  return key() !== null;
}

/** A new token and the sha256 the database keeps. Throws when the server key is missing. */
export function newUploadToken(): { token: string; tokenHash: string } {
  const k = key();
  if (!k) throw new Error('upload tokens are unavailable: JWT_SECRET is not set');
  const random = randomBytes(RANDOM_BYTES);
  const token = Buffer.concat([random, tag(k, random)]).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

/** True only for a token this server minted (and the key is present). Constant-time on the tag. */
export function verifyUploadToken(token: string): boolean {
  if (!TOKEN_SHAPE.test(token)) return false;
  const k = key();
  if (!k) return false;
  const raw = Buffer.from(token, 'base64url');
  // Reject a non-canonical encoding (the same bytes under another spelling would hash to another token_hash).
  if (raw.length !== TOKEN_BYTES || raw.toString('base64url') !== token) return false;
  return timingSafeEqual(raw.subarray(RANDOM_BYTES), tag(k, raw.subarray(0, RANDOM_BYTES)));
}
