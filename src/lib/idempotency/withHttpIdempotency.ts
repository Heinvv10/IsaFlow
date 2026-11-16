/**
 * Replay-safe POST routes (audit 2026-11-15, bank WP2 row 7). A route that posts a journal wraps its handler:
 *
 *   withAuth(withErrorHandler(withCsrf(withWriteAccess(withHttpIdempotency('route-name', handler)))))
 *
 * ONLY SAFE FOR A HANDLER THAT KEEPS ITS REFUSALS INSIDE A SAVEPOINT (withJournalDateRefusal) or decides them before
 * its first write: `withAuth` COMMITs a 4xx, so a handler that wrote and then answered 4xx would leave the write
 * committed with the claim freed, and a resend would post it again.
 *
 * With an `Idempotency-Key` header (a UUID the form made when it opened) the request first CLAIMS
 * (company_id, route, key) in its own transaction:
 *   - claimed: the handler runs. A 2xx answer is stored on the claim; any other answer, returned OR thrown, frees the
 *     claim (a refusal is not a result to replay: the person fixes the form and resends); a 5xx rolls the request
 *     back, claim included.
 *   - already there: the first request's committed answer comes back verbatim (same status, same body), no handler
 *     run, no second journal. The same key on a different body, or from a different user, is refused 422.
 * Two requests racing on one key: the second INSERT waits on the unique index until the first commits (then replays
 * it) or rolls back (then it claims and runs). The wait is bounded at 5 s (503 + Retry-After), and the bound is put
 * back to the caller's own setting once the claim is decided, so the handler's waits are not changed by it.
 * No header: the handler runs as it always did. Keys are scoped per route, on purpose: one key on two routes is two
 * requests.
 *
 * Retention: a key is good for 24 h. The claim path first deletes an expired row for ITS OWN key (so an old key is a
 * new request, never a stale replay), then prunes up to PRUNE_BATCH of the company's rows older than 7 days, skipping
 * any a concurrent claim holds (no deadlock between two prunes). Bounded work per claim, no cron.
 */
import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import type { CompanyAuthedRequest } from '@/lib/auth';

type Handler<Req extends NextApiRequest> = (req: Req, res: NextApiResponse) => unknown | Promise<unknown>;

/** How long a key replays its first answer. */
export const KEY_TTL_HOURS = 24;
/** Rows older than this are pruned by the next claim of the same company. */
const PRUNE_AFTER_DAYS = 7;
const PRUNE_BATCH = 20;
/** The longest a claim waits on another request holding the same key. */
export const CLAIM_WAIT_MS = 5_000;
/** An answer bigger than this is not stored (a replay then says so instead of returning a truncated body). */
export const MAX_STORED_BODY_BYTES = 64 * 1024;

/** JSON with object keys sorted at every depth: the same body hashes the same however the client ordered it. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const payloadHashOf = (body: unknown): string => createHash('sha256').update(canonical(body)).digest('hex');

type Stored = { id: string; payload_hash: string; created_by: string | null; status_code: number | null; response_body: unknown };

export function withHttpIdempotency<Req extends NextApiRequest>(route: string, handler: Handler<Req>): Handler<Req> {
  return async (req, res) => {
    const header = req.headers?.['idempotency-key']; // unit tests drive the handler with a bare request
    if (header === undefined) return handler(req, res);
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw || !UUID_RE.test(raw)) return apiResponse.validationError(res, { 'Idempotency-Key': ['must be a UUID'] });
    const key = raw.toLowerCase();
    const { companyId, user } = req as unknown as CompanyAuthedRequest;
    const userId = user?.id ?? null;
    const hash = payloadHashOf(req.body);

    // A transaction-local bound for the claim's waits, never looser than one already set; put back afterwards.
    const prev = ((await sql`SELECT setting::INT AS prev FROM pg_settings WHERE name = 'lock_timeout'`) as { prev: number }[])[0]?.prev ?? 0;
    const bound = prev > 0 && prev < CLAIM_WAIT_MS ? prev : CLAIM_WAIT_MS;
    await sql`SELECT set_config('lock_timeout', ${`${bound}ms`}, true)`;
    const claim = async (): Promise<string | null> => {
      const rows = (await sql`
        INSERT INTO http_idempotency_keys (company_id, route, idempotency_key, payload_hash, created_by)
        VALUES (${companyId}::UUID, ${route}, ${key}, ${hash}, ${userId})
        ON CONFLICT (company_id, route, idempotency_key) DO NOTHING
        RETURNING id`) as { id: string }[];
      return rows[0]?.id ?? null;
    };
    const find = async (): Promise<Stored | undefined> => ((await sql`
      SELECT id, payload_hash, created_by, status_code, response_body FROM http_idempotency_keys
      WHERE company_id = ${companyId}::UUID AND route = ${route} AND idempotency_key = ${key}`) as Stored[])[0];

    await sql`
      DELETE FROM http_idempotency_keys
      WHERE company_id = ${companyId}::UUID AND route = ${route} AND idempotency_key = ${key}
        AND created_at < now() - make_interval(hours => ${KEY_TTL_HOURS})`;
    await sql`
      DELETE FROM http_idempotency_keys WHERE id IN (
        SELECT id FROM http_idempotency_keys
        WHERE company_id = ${companyId}::UUID AND created_at < now() - make_interval(days => ${PRUNE_AFTER_DAYS})
        ORDER BY created_at LIMIT ${PRUNE_BATCH} FOR UPDATE SKIP LOCKED)`;

    let claimed = await claim();
    if (claimed === null) {
      const first = await find();
      if (first === undefined) {
        claimed = await claim(); // its owner rolled back or freed it between our INSERT and SELECT: claim once more
      } else if (first.created_by !== userId) {
        return apiResponse.validationError(res, { 'Idempotency-Key': ['this key is already in use by another request'] },
          'Idempotency key already in use');
      } else if (first.payload_hash !== hash) {
        return apiResponse.validationError(res, {
          'Idempotency-Key': ['this key was already used for a different request'],
        }, 'Idempotency key reused with a different request');
      } else if (first.status_code === null) {
        // A committed claim that never got an answer (its handler threw below 500 once): nothing was kept, so reclaim.
        await sql`DELETE FROM http_idempotency_keys WHERE id = ${first.id}::UUID AND status_code IS NULL`;
        claimed = await claim();
      } else if (first.response_body === null) {
        return apiResponse.conflict(res, 'This request was already processed, but its answer is too large to repeat. '
          + 'Reload the page to see the result.');
      } else {
        await sql`SELECT set_config('lock_timeout', ${`${prev}ms`}, true)`;
        return void res.status(first.status_code).json(first.response_body);
      }
      if (claimed === null) {
        return apiResponse.conflict(res, 'This request is still being processed. Wait a moment and check before sending it again.');
      }
    }
    await sql`SELECT set_config('lock_timeout', ${`${prev}ms`}, true)`;

    let answered: { status: number; body: unknown } | null = null;
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      answered = { status: res.statusCode, body };
      return send(body);
    };
    const free = () => sql`DELETE FROM http_idempotency_keys WHERE id = ${claimed}::UUID AND company_id = ${companyId}::UUID`;
    try {
      await handler(req, res);
    } catch (err) {
      // Mapped below 500 by withErrorHandler (a 409, say) the request would COMMIT the claim with no answer.
      try { await free(); } catch (freeErr) {
        log.warn('Idempotency claim not freed after a handler error', { error: freeErr, route }, 'idempotency');
      }
      throw err;
    }

    const result = answered as { status: number; body: unknown } | null;
    if (result && result.status >= 200 && result.status < 300) {
      const text = JSON.stringify(result.body);
      // Too large to keep: the status is stored with no body, and a replay says "already processed, reload".
      const body = text.length > MAX_STORED_BODY_BYTES ? null : text;
      await sql`
        UPDATE http_idempotency_keys SET status_code = ${result.status}, response_body = ${body}::jsonb
        WHERE id = ${claimed}::UUID AND company_id = ${companyId}::UUID`;
    } else {
      await free();
    }
  };
}
