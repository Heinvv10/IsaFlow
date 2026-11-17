/**
 * PUT /api/mcp/uploads/<token> — the byte leg of create_upload_urls → finalize_uploads.
 *
 * The token in the path is the ONLY credential: no cookie, no CSRF, no bearer. It is one-shot (a pending, unexpired
 * intent only; the first good PUT stages the bytes and the url stops working), expires 30 minutes after issue, and
 * only its sha256 is stored. Usage: `curl -sS -T file.pdf "<url>"`.
 *
 * The body is streamed with a hard cap of the declared size, so nothing larger than the agent announced (itself within
 * the target's cap) is ever buffered, and a body that stalls (no data for 30 s, or not in within 5 min) or is aborted
 * stops the read: 400, nothing staged. The bytes must be exactly the declared size and hash, their magic bytes must
 * match the declared mime type, and they must be a COMPLETE file of that type (uploadBytesCheck); a bad PUT is refused
 * and leaves the url usable for a corrected one until it expires. A good PUT opens a 2-hour finalize window and is
 * audited. finalize_uploads verifies everything again before any document row is written.
 *
 * Not a withAuth route: there is no user. The lookup and the staging write (with its audit row) each run in their own
 * short public-route transaction on the service pool (the body is read between them, holding no connection), and the
 * write names the intent's id AND company_id.
 *
 * The token is self-authenticating (@/lib/mcp/uploadToken: 16 random bytes + a 16-byte HMAC tag keyed from
 * JWT_SECRET). Its tag is verified in process, constant-time, FIRST: a forged, tampered or malformed token (or any
 * token when the server key is missing) is 404 with no rate-limit charge and no query, so junk can neither drive
 * lookups nor spend a bucket a real token needs. Then, for a token this server minted:
 *   - the per-token bucket (20/min: a replayed url cannot drive lookups);
 *   - the lookup; a miss (an expired and deleted intent) charges only the miss bucket and answers 404;
 *   - for a real intent: the platform ceiling, then the per-company bucket, then the global sweep.
 * No bucket is per IP: behind cloudflared / nginx every caller has the proxy's IP. Optional hardening (ops): an edge
 * rate limit for /api/mcp/uploads/ at nginx/Cloudflare, where the real client IP is known.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { checkRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { readUploadBody, UploadBodyError } from '@/lib/mcp/uploadBody';
import { verifyUploadToken } from '@/lib/mcp/uploadToken';
import { uploadBytesRefusal } from '@/lib/mcp/uploadBytesCheck';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { sweepExpiredUploadsQuietly } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import {
  findIntentByToken, hashUploadToken, stageUploadBytes,
} from '@/modules/accounting/services/core/mcpUploadIntentStore';

export const config = { api: { bodyParser: false } };

const WINDOW = 60;
/** Every PUT that names a real intent, all companies: far above any real batch, low enough to bound a flood. */
const GLOBAL_PER_MINUTE = 3000;
/** Minted tokens that name no intent (expired and deleted), all callers. Gates those 404s only. */
const MISS_PER_MINUTE = 600;
/** One url is one file; retries after a refused body are the only repeats. */
const TOKEN_PER_MINUTE = 20;
/** A company's agent may PUT a 100-file batch several times a minute. */
const COMPANY_PER_MINUTE = 600;

const limit = (key: string, max: number) => checkRateLimit(key, { max, windowSecs: WINDOW });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  // First, before any limiter or query: only a token this server minted goes further.
  if (!verifyUploadToken(token)) return apiResponse.notFound(res, 'Upload');
  if (!(await limit(`mcp-upload-token:${hashUploadToken(token).slice(0, 32)}`, TOKEN_PER_MINUTE))) {
    return apiResponse.tooManyRequests(res);
  }
  const intent = await withPublicRouteTransaction('mcp-upload lookup', () => findIntentByToken(token));
  if (!intent) {
    return (await limit('mcp-upload:miss', MISS_PER_MINUTE)) ? apiResponse.notFound(res, 'Upload') : apiResponse.tooManyRequests(res);
  }
  if (!(await limit('mcp-upload:all', GLOBAL_PER_MINUTE)) || !(await limit(`mcp-upload-company:${intent.companyId}`, COMPANY_PER_MINUTE))) {
    return apiResponse.tooManyRequests(res);
  }
  await sweepExpiredUploadsQuietly();

  if (intent.status !== 'pending') return apiResponse.conflict(res, 'This upload url was already used');
  if (intent.expired) return apiResponse.conflict(res, 'This upload url has expired: create a new one');

  const tooLarge = `Body is larger than the declared ${intent.declaredSize} bytes`;
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > intent.declaredSize) {
    return apiResponse.error(res, ErrorCode.PAYLOAD_TOO_LARGE, tooLarge);
  }
  let bytes: Buffer;
  try {
    bytes = await readUploadBody(req, intent.declaredSize);
  } catch (err) {
    if (!(err instanceof UploadBodyError)) throw err;
    // The rest of the body is never read: close the connection rather than leave it half-consumed.
    res.setHeader('Connection', 'close');
    if (err.stop === 'too_large') return apiResponse.error(res, ErrorCode.PAYLOAD_TOO_LARGE, tooLarge);
    log.warn('MCP upload body not completed', { uploadId: intent.id, stop: err.stop }, 'mcp-uploads');
    return apiResponse.badRequest(res, err.stop === 'stalled'
      ? 'The upload stalled before the whole body arrived: nothing was staged, PUT the file again'
      : 'The upload was interrupted before the whole body arrived: nothing was staged, PUT the file again');
  }
  const refusal = uploadBytesRefusal(bytes, intent);
  if (refusal) return apiResponse.badRequest(res, `Refused: ${refusal}`);

  const staged = await withPublicRouteTransaction('mcp-upload stage', async () => {
    if (!(await stageUploadBytes(intent.companyId, intent.id, bytes))) return false;
    await logAuditOrThrow({
      companyId: intent.companyId, userId: intent.createdBy, action: 'update', entityType: 'mcp_upload_intent',
      entityId: intent.id, entityRef: intent.fileName.slice(0, 100),
      changes: { fields: [], metadata: {
        source: 'mcp upload PUT', upload_id: intent.id, status: 'uploaded', size: String(bytes.length), sha256: intent.sha256,
        target_kind: intent.targetKind, target_id: intent.targetId, token_jti: intent.createdTokenJti ?? '',
      } },
    });
    return true;
  });
  if (!staged) return apiResponse.conflict(res, 'This upload url was already used or has expired');
  log.info('MCP upload staged', { companyId: intent.companyId, uploadId: intent.id, size: bytes.length }, 'mcp-uploads');
  return apiResponse.success(res, { upload_id: intent.id, status: 'uploaded', size: bytes.length });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
