/**
 * Webhook endpoint writes, on the migration_admin pool (S-07e part B,
 * migration 946): no app role may INSERT or DELETE a webhook_endpoints row, or
 * UPDATE any column but the delivery stamps (last_triggered_at, failure_count).
 * SQL injected on an app pool can forge the claims RLS judges, and a planted or
 * re-pointed endpoint (url, events, is_active) is a standing feed of a company's
 * events to an outside URL.
 *
 * `companyId` is the verified request's (the route's `req.companyId`) or the
 * endpoint's own company (fireWebhook's auto-disable). This role bypasses RLS,
 * so every statement carries `company_id = $n`.
 */

import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';

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

/**
 * fireWebhook's auto-disable: switches the endpoint off once its failure_count
 * (stamped on the app pool) has reached `threshold`. The count is re-checked
 * here, so a success that reset it in between keeps the endpoint on.
 */
export async function disableFailingEndpoint(companyId: string, id: string, threshold: number): Promise<void> {
  await migrationAdminTx('auto-disable webhook endpoint', (client) => client.query(
    `UPDATE webhook_endpoints SET is_active = false
      WHERE id = $1::UUID AND company_id = $2::UUID AND failure_count >= $3`,
    [id, companyId, threshold],
  ));
}
