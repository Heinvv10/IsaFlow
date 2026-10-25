/**
 * Every webhook_endpoints write, on the migration_admin login (S-07e part B,
 * migration 946): no app role may INSERT, UPDATE or DELETE a row. SQL injected
 * on an app pool can forge the claims RLS judges: a planted or re-pointed
 * endpoint (url, events, is_active) is a standing feed of a company's events
 * to an outside URL, and a forged failure_count delays or hastens its
 * auto-disable. All of them run on routeAdminPool.ts's pool (a pool of its own on
 * that login, so neither a burst of deliveries nor a blocked delete ever holds a
 * sign-in's connection), each waiting at most 2 s for the row (55P03 after that:
 * the route answers 503). Create and delete are routeAdminQuery, update is
 * routeAdminTx (its field-by-field statements and re-read are atomic);
 * fireWebhook's delivery stamp, which also switches an endpoint off after its
 * threshold of failures, is routeAdminQuery.
 *
 * `companyId` is the verified request's (the route's `req.companyId`) or the
 * endpoint's own company (fireWebhook). This role bypasses RLS, so every
 * statement carries `company_id = $n`.
 */

import { routeAdminQuery, routeAdminTx } from '@/lib/auth/routeAdminPool';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface EndpointInsert {
  name: string;
  url: string;
  /** Already encrypted at rest (encryptToken), or null. */
  secretAtRest: string | null;
  events: string[];
  isActive: boolean;
}

export interface EndpointChanges {
  name?: string;
  url?: string;
  /** Already encrypted at rest, or null to clear; undefined leaves it. */
  secretAtRest?: string | null;
  events?: string[];
  isActive?: boolean;
}

const SET_NAME = `UPDATE webhook_endpoints SET name = $1 WHERE id = $2::UUID AND company_id = $3::UUID RETURNING id`;
const SET_URL = `UPDATE webhook_endpoints SET url = $1 WHERE id = $2::UUID AND company_id = $3::UUID RETURNING id`;
const SET_SECRET = `UPDATE webhook_endpoints SET secret = $1 WHERE id = $2::UUID AND company_id = $3::UUID RETURNING id`;
const SET_EVENTS = `UPDATE webhook_endpoints SET events = $1::TEXT[] WHERE id = $2::UUID AND company_id = $3::UUID RETURNING id`;
const SET_ACTIVE = `UPDATE webhook_endpoints SET is_active = $1 WHERE id = $2::UUID AND company_id = $3::UUID RETURNING id`;

export async function insertEndpoint(companyId: string, input: EndpointInsert): Promise<Row> {
  const rows = await routeAdminQuery('create webhook endpoint',
    `INSERT INTO webhook_endpoints (company_id, name, url, secret, events, is_active)
     VALUES ($1::UUID, $2, $3, $4, $5::TEXT[], $6)
     RETURNING *`,
    [companyId, input.name, input.url, input.secretAtRest, input.events, input.isActive],
  );
  return rows[0]!;
}

/**
 * Applies each given field in one transaction, so a refusal part-way leaves the
 * endpoint unchanged. Returns the row as it now stands, or null when the
 * endpoint is not this company's.
 */
export async function updateEndpoint(companyId: string, id: string, changes: EndpointChanges): Promise<Row | null> {
  return routeAdminTx('update webhook endpoint', async (client) => {
    const set = async (statement: string, value: unknown): Promise<boolean> =>
      (await client.query(statement, [value, id, companyId])).rows.length > 0;
    if (changes.name !== undefined && !(await set(SET_NAME, changes.name))) return null;
    if (changes.url !== undefined && !(await set(SET_URL, changes.url))) return null;
    if (changes.secretAtRest !== undefined && !(await set(SET_SECRET, changes.secretAtRest))) return null;
    if (changes.events !== undefined && !(await set(SET_EVENTS, changes.events))) return null;
    if (changes.isActive !== undefined && !(await set(SET_ACTIVE, changes.isActive))) return null;
    const rows = (await client.query(
      `SELECT * FROM webhook_endpoints WHERE id = $1::UUID AND company_id = $2::UUID`,
      [id, companyId],
    )).rows as Row[];
    return rows[0] ?? null;
  });
}

export async function deleteEndpoint(companyId: string, id: string): Promise<void> {
  await routeAdminQuery('delete webhook endpoint',
    `DELETE FROM webhook_endpoints WHERE id = $1::UUID AND company_id = $2::UUID`,
    [id, companyId],
  );
}

const STAMP_SUCCESS = `UPDATE webhook_endpoints SET last_triggered_at = NOW(), failure_count = 0
  WHERE id = $1::UUID AND company_id = $2::UUID`;
const STAMP_FAILURE = `UPDATE webhook_endpoints
  SET failure_count = failure_count + 1,
      is_active = CASE WHEN failure_count + 1 >= $3 THEN false ELSE is_active END
  WHERE id = $1::UUID AND company_id = $2::UUID`;

/** How long a refused failure stamp waits before its one retry (a burst's pool pressure is brief). */
export const STAMP_RETRY_DELAY_MS = 250;

/**
 * fireWebhook's stamp after one delivery: a success stamps last_triggered_at and resets
 * failure_count; a failure counts up and, in the same statement, switches the endpoint off
 * once the count reaches `disableAfter`. A failure stamp that is refused (pool or lock timeout,
 * 55P03) is retried once after STAMP_RETRY_DELAY_MS: a dropped failure is never counted, so
 * under steady pool pressure a dead endpoint could otherwise never reach the threshold. Throws
 * when the retry is refused too (the residual: that one failure is not counted). A success
 * stamp is not retried: a lost success only leaves an old last_triggered_at and failure_count.
 */
export async function stampDelivery(companyId: string, id: string, success: boolean, disableAfter: number): Promise<void> {
  if (success) {
    await routeAdminQuery('webhook delivery stamp', STAMP_SUCCESS, [id, companyId]);
    return;
  }
  try {
    await routeAdminQuery('webhook delivery failure stamp', STAMP_FAILURE, [id, companyId, disableAfter]);
  } catch (firstErr) {
    log.warn('Webhook failure stamp refused; retrying once', { endpointId: id, error: firstErr }, 'webhook');
    await new Promise<void>((resolve) => setTimeout(resolve, STAMP_RETRY_DELAY_MS));
    await routeAdminQuery('webhook delivery failure stamp (retry)', STAMP_FAILURE, [id, companyId, disableAfter]);
  }
}
