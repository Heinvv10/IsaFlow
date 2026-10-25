/**
 * Every webhook_endpoints write, on the migration_admin login (S-07e part B,
 * migration 946): no app role may INSERT, UPDATE or DELETE a row. SQL injected
 * on an app pool can forge the claims RLS judges: a planted or re-pointed
 * endpoint (url, events, is_active) is a standing feed of a company's events
 * to an outside URL, and a forged failure_count delays or hastens its
 * auto-disable. Create, update and delete run on migrationAdminTx (the
 * request's writes); fireWebhook's delivery stamp, which also switches an
 * endpoint off after its threshold of failures, on routeAdminQuery (a pool of
 * its own, so a burst of deliveries never queues a sign-in).
 *
 * `companyId` is the verified request's (the route's `req.companyId`) or the
 * endpoint's own company (fireWebhook). This role bypasses RLS, so every
 * statement carries `company_id = $n`.
 */

import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { routeAdminQuery } from '@/lib/auth/routeAdminPool';

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
  const rows = await migrationAdminTx('create webhook endpoint', async (client) => (await client.query(
    `INSERT INTO webhook_endpoints (company_id, name, url, secret, events, is_active)
     VALUES ($1::UUID, $2, $3, $4, $5::TEXT[], $6)
     RETURNING *`,
    [companyId, input.name, input.url, input.secretAtRest, input.events, input.isActive],
  )).rows as Row[]);
  return rows[0]!;
}

/**
 * Applies each given field in one transaction, so a refusal part-way leaves the
 * endpoint unchanged. Returns the row as it now stands, or null when the
 * endpoint is not this company's.
 */
export async function updateEndpoint(companyId: string, id: string, changes: EndpointChanges): Promise<Row | null> {
  return migrationAdminTx('update webhook endpoint', async (client) => {
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
  await migrationAdminTx('delete webhook endpoint', (client) => client.query(
    `DELETE FROM webhook_endpoints WHERE id = $1::UUID AND company_id = $2::UUID`,
    [id, companyId],
  ));
}

const STAMP_SUCCESS = `UPDATE webhook_endpoints SET last_triggered_at = NOW(), failure_count = 0
  WHERE id = $1::UUID AND company_id = $2::UUID`;
const STAMP_FAILURE = `UPDATE webhook_endpoints
  SET failure_count = failure_count + 1,
      is_active = CASE WHEN failure_count + 1 >= $3 THEN false ELSE is_active END
  WHERE id = $1::UUID AND company_id = $2::UUID`;

/**
 * fireWebhook's stamp after one delivery: a success stamps last_triggered_at and resets
 * failure_count; a failure counts up and, in the same statement, switches the endpoint off
 * once the count reaches `disableAfter`. Throws on a refusal (55P03 after a 2 s wait included).
 */
export async function stampDelivery(companyId: string, id: string, success: boolean, disableAfter: number): Promise<void> {
  if (success) await routeAdminQuery('webhook delivery stamp', STAMP_SUCCESS, [id, companyId]);
  else await routeAdminQuery('webhook delivery failure stamp', STAMP_FAILURE, [id, companyId, disableAfter]);
}
