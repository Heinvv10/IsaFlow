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
 * write names the intent's id AND company_id. Rate limits: the client IP is the proxy's (cloudflared / nginx), so no
 * bucket is per IP. A malformed or unknown token is charged ONLY to its own miss bucket (which can refuse misses but
 * never a real token); a token that names an intent is charged per token, to the platform ceiling and per company,
 * and only then runs the global sweep of expired uploads. So junk can neither drain the ceiling nor drive the sweep.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { checkRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { readUploadBody, UploadBodyError } from '@/lib/mcp/uploadBody';
import { uploadBytesRefusal } from '@/lib/mcp/uploadBytesCheck';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { sweepExpiredUploadsQuietly } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import {
  TOKEN_RE, findIntentByToken, hashUploadToken, stageUploadBytes,
} from '@/modules/accounting/services/core/mcpUploadIntentStore';

export const config = { api: { bodyParser: false } };

const WINDOW = 60;
/** Every PUT that names a real intent, all companies: far above any real batch, low enough to bound a flood. */
const GLOBAL_PER_MINUTE = 3000;
/** Malformed or unknown tokens, all callers (they share the proxy's IP). Gates misses only. */
const MISS_PER_MINUTE = 600;
/** One url is one file; retries after a refused body are the only repeats. */
const TOKEN_PER_MINUTE = 20;
/** A company's agent may PUT a 100-file batch several times a minute. */
const COMPANY_PER_MINUTE = 600;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const intent = TOKEN_RE.test(token)
    ? await withPublicRouteTransaction('mcp-upload lookup', () => findIntentByToken(token))
    : null;
  if (!intent) {
    if (!(await checkRateLimit('mcp-upload:miss', { max: MISS_PER_MINUTE, windowSecs: WINDOW }))) {
      return apiResponse.tooManyRequests(res);
    }
    return apiResponse.notFound(res, 'Upload');
  }
  const admitted = await checkRateLimit(`mcp-upload-token:${hashUploadToken(token).slice(0, 32)}`, { max: TOKEN_PER_MINUTE, windowSecs: WINDOW })
    && await checkRateLimit('mcp-upload:all', { max: GLOBAL_PER_MINUTE, windowSecs: WINDOW })
    && await checkRateLimit(`mcp-upload-company:${intent.companyId}`, { max: COMPANY_PER_MINUTE, windowSecs: WINDOW });
  if (!admitted) return apiResponse.tooManyRequests(res);
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
