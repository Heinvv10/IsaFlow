/**
 * PUT /api/mcp/uploads/<token> — the byte leg of create_upload_urls → finalize_uploads.
 *
 * The token in the path is the ONLY credential: no cookie, no CSRF, no bearer. It is one-shot (a pending, unexpired
 * intent only; the first good PUT stages the bytes and the url stops working), expires 30 minutes after issue, and
 * only its sha256 is stored. Usage: `curl -sS -T file.pdf "<url>"`.
 *
 * The body is streamed with a hard cap of the declared size, so nothing larger than the agent announced (itself within
 * the target's cap) is ever buffered. The bytes must be exactly the declared size and hash and their magic bytes must
 * match the declared mime type; a bad PUT is refused and leaves the url usable for a corrected one until it expires.
 * finalize_uploads verifies everything again before any document row is written.
 *
 * Not a withAuth route: there is no user. The lookup and the staging write each run in their own short public-route
 * transaction on the service pool (the body is read between them, holding no connection), and the write names the
 * intent's id AND company_id. Rate-limited per IP.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { magicBytesMatchMime } from '@/lib/fileMagic';
import { log } from '@/lib/logger';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import {
  TOKEN_RE, findIntentByToken, sha256Hex, stageUploadBytes,
} from '@/modules/accounting/services/core/mcpUploadIntentStore';

export const config = { api: { bodyParser: false } };

class TooLarge extends Error {}

/** The request body, refusing (TooLarge) as soon as it passes `cap` bytes. */
function readCapped(req: NextApiRequest, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        req.removeAllListeners('data');
        req.resume();
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);
  if (!(await checkRateLimit(`mcp-upload-ip:${getClientIp(req)}`, { max: 300, windowSecs: 60 }))) {
    return apiResponse.tooManyRequests(res);
  }
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!TOKEN_RE.test(token)) return apiResponse.notFound(res, 'Upload');

  const intent = await withPublicRouteTransaction('mcp-upload lookup', () => findIntentByToken(token));
  if (!intent) return apiResponse.notFound(res, 'Upload');
  if (intent.status !== 'pending') return apiResponse.conflict(res, 'This upload url was already used');
  if (intent.expired) return apiResponse.conflict(res, 'This upload url has expired: create a new one');

  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > intent.declaredSize) {
    return apiResponse.error(res, ErrorCode.PAYLOAD_TOO_LARGE, `Body is larger than the declared ${intent.declaredSize} bytes`);
  }
  let bytes: Buffer;
  try {
    bytes = await readCapped(req, intent.declaredSize);
  } catch (err) {
    if (err instanceof TooLarge) {
      return apiResponse.error(res, ErrorCode.PAYLOAD_TOO_LARGE, `Body is larger than the declared ${intent.declaredSize} bytes`);
    }
    throw err;
  }
  if (bytes.length !== intent.declaredSize) {
    return apiResponse.badRequest(res, `Body is ${bytes.length} bytes; ${intent.declaredSize} were declared`);
  }
  if (sha256Hex(bytes) !== intent.sha256) return apiResponse.badRequest(res, 'Body does not match the declared sha256');
  if (!magicBytesMatchMime(bytes, intent.mimeType)) {
    return apiResponse.badRequest(res, `Body does not match the declared mime_type ${intent.mimeType}`);
  }

  const staged = await withPublicRouteTransaction('mcp-upload stage',
    () => stageUploadBytes(intent.companyId, intent.id, bytes));
  if (!staged) return apiResponse.conflict(res, 'This upload url was already used or has expired');
  log.info('MCP upload staged', { companyId: intent.companyId, uploadId: intent.id, size: bytes.length }, 'mcp-uploads');
  return apiResponse.success(res, { upload_id: intent.id, status: 'uploaded', size: bytes.length });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
