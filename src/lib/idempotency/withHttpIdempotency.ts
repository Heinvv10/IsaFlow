/**
 * Replay-safe POST routes (audit 2026-11-15, bank WP2 row 7). A route that posts a journal wraps its handler:
 *
 *   withAuth(withErrorHandler(withCsrf(withWriteAccess(withHttpIdempotency('route-name', handler)))))
 *
 * With an `Idempotency-Key` header (a UUID the form made when it opened) the request first CLAIMS
 * (company_id, route, key) in its own transaction:
 *   - claimed: the handler runs. A 2xx answer is stored on the claim; any other answer deletes the claim before the
 *     request commits (a refusal is not a result to replay: the person fixes the form and resends); a throw rolls the
 *     request back, claim included.
 *   - already there: the first request's committed answer comes back verbatim (same status, same body), no handler
 *     run, no second journal. The same key on a different body is refused 422.
 * Two requests racing on one key: the second INSERT waits on the unique index until the first commits (then replays
 * it) or rolls back (then it claims and runs). The wait is bounded by the request's lock timeout (503 + Retry-After).
 * No header: the handler runs as it always did.
 */
import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import type { CompanyAuthedRequest } from '@/lib/auth';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown | Promise<unknown>;

/** JSON with object keys sorted at every depth: the same body hashes the same however the client ordered it. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const payloadHashOf = (body: unknown): string => createHash('sha256').update(canonical(body)).digest('hex');

type Stored = { payload_hash: string; status_code: number | null; response_body: unknown };

export function withHttpIdempotency(route: string, handler: Handler): Handler {
  return async (req, res) => {
    const header = req.headers?.['idempotency-key']; // unit tests drive the handler with a bare request
    if (header === undefined) return handler(req, res);
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !UUID_RE.test(key)) {
      return apiResponse.validationError(res, { 'Idempotency-Key': ['must be a UUID'] });
    }
    const { companyId, user } = req as CompanyAuthedRequest;
    const hash = payloadHashOf(req.body);

    const claimed = (await sql`
      INSERT INTO http_idempotency_keys (company_id, route, idempotency_key, payload_hash, created_by)
      VALUES (${companyId}::UUID, ${route}, ${key.toLowerCase()}, ${hash}, ${user?.id ?? null})
      ON CONFLICT (company_id, route, idempotency_key) DO NOTHING
      RETURNING id`) as { id: string }[];

    if (claimed.length === 0) {
      const [first] = (await sql`
        SELECT payload_hash, status_code, response_body FROM http_idempotency_keys
        WHERE company_id = ${companyId}::UUID AND route = ${route} AND idempotency_key = ${key.toLowerCase()}`) as Stored[];
      if (first?.payload_hash !== undefined && first.payload_hash !== hash) {
        return apiResponse.validationError(res, {
          'Idempotency-Key': ['this key was already used for a different request'],
        }, 'Idempotency key reused with a different request');
      }
      if (first?.status_code != null) return void res.status(first.status_code).json(first.response_body);
      return apiResponse.conflict(res, 'This request is still being processed. Wait a moment and check before sending it again.');
    }

    let answered: { status: number; body: unknown } | null = null;
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      answered = { status: res.statusCode, body };
      return send(body);
    };
    await handler(req, res);

    const result = answered as { status: number; body: unknown } | null;
    if (result && result.status >= 200 && result.status < 300) {
      await sql`
        UPDATE http_idempotency_keys SET status_code = ${result.status}, response_body = ${JSON.stringify(result.body)}::jsonb
        WHERE id = ${claimed[0]!.id}::UUID AND company_id = ${companyId}::UUID`;
    } else {
      await sql`DELETE FROM http_idempotency_keys WHERE id = ${claimed[0]!.id}::UUID AND company_id = ${companyId}::UUID`;
    }
  };
}
