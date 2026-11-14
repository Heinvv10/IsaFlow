/**
 * Admin Webhook Service
 * Cross-company webhook management for super_admin use.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { deliverToEndpoint } from '@/modules/accounting/services/core/webhookService';

type Row = DbRow;

export interface AdminWebhook {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  failureCount: number;
  lastTriggeredAt: string | null;
  lastDeliveryStatus: 'success' | 'failed' | 'none';
  lastDeliveryAt: string | null;
  createdAt: string;
}

export interface AdminWebhookDetail extends AdminWebhook {
  deliveries: DeliveryAttempt[];
}

export interface DeliveryAttempt {
  id: string;
  webhookId: string;
  event: string;
  responseStatus: number | null;
  responseBody: string | null;
  success: boolean;
  deliveredAt: string;
}

export interface ListWebhooksParams {
  search?: string;
  status?: 'active' | 'disabled' | 'all';
  companyId?: string;
  page?: number;
  limit?: number;
}

export interface ListWebhooksResult {
  items: AdminWebhook[];
  total: number;
  page: number;
  limit: number;
}

function mapWebhook(row: Row, lastDelivery: Row | null): AdminWebhook {
  let lastDeliveryStatus: 'success' | 'failed' | 'none' = 'none';
  if (lastDelivery) {
    lastDeliveryStatus = lastDelivery.success ? 'success' : 'failed';
  }
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    companyName: row.company_name ? String(row.company_name) : 'Unknown',
    name: row.name ? String(row.name) : '',
    url: String(row.url),
    events: Array.isArray(row.events) ? (row.events as string[]) : [],
    isActive: Boolean(row.is_active),
    failureCount: Number(row.failure_count ?? 0),
    lastTriggeredAt: row.last_triggered_at
      ? (row.last_triggered_at instanceof Date
          ? row.last_triggered_at.toISOString()
          : String(row.last_triggered_at))
      : null,
    lastDeliveryStatus,
    lastDeliveryAt: lastDelivery?.delivered_at
      ? (lastDelivery.delivered_at instanceof Date
          ? lastDelivery.delivered_at.toISOString()
          : String(lastDelivery.delivered_at))
      : null,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  };
}

function mapDelivery(row: Row): DeliveryAttempt {
  return {
    id: String(row.id),
    webhookId: String(row.webhook_id),
    event: String(row.event),
    responseStatus: row.response_status != null ? Number(row.response_status) : null,
    responseBody: row.response_body ? String(row.response_body) : null,
    success: Boolean(row.success),
    deliveredAt: row.delivered_at instanceof Date
      ? row.delivered_at.toISOString()
      : String(row.delivered_at),
  };
}

export async function listAdminWebhooks(params: ListWebhooksParams): Promise<ListWebhooksResult> {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const offset = (page - 1) * limit;

  const searchFilter = params.search ? `%${params.search.toLowerCase()}%` : null;
  const companyFilter = params.companyId ?? null;
  const showActive = params.status === 'active' ? true : params.status === 'disabled' ? false : null;

  // ::TEXT / ::BOOLEAN casts on every interpolation so PG can resolve the parameter
  // type when the value is NULL — without them the planner raises 42P18
  // (indeterminate_datatype) before execution.
  const rows = (await sql`
    SELECT
      we.*,
      c.name AS company_name,
      (
        SELECT row_to_json(ld)
        FROM (
          SELECT id, success, delivered_at
          FROM webhook_deliveries
          WHERE webhook_id = we.id
          ORDER BY delivered_at DESC
          LIMIT 1
        ) ld
      ) AS last_delivery
    FROM webhook_endpoints we
    JOIN companies c ON c.id = we.company_id
    WHERE (
      ${searchFilter}::TEXT IS NULL
      OR LOWER(we.url) LIKE ${searchFilter}::TEXT
      OR LOWER(c.name) LIKE ${searchFilter}::TEXT
    )
    AND (${companyFilter}::UUID IS NULL OR we.company_id = ${companyFilter}::UUID)
    AND (${showActive}::BOOLEAN IS NULL OR we.is_active = ${showActive}::BOOLEAN)
    ORDER BY we.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as Row[];

  const countRows = (await sql`
    SELECT COUNT(*) AS total
    FROM webhook_endpoints we
    JOIN companies c ON c.id = we.company_id
    WHERE (
      ${searchFilter}::TEXT IS NULL
      OR LOWER(we.url) LIKE ${searchFilter}::TEXT
      OR LOWER(c.name) LIKE ${searchFilter}::TEXT
    )
    AND (${companyFilter}::UUID IS NULL OR we.company_id = ${companyFilter}::UUID)
    AND (${showActive}::BOOLEAN IS NULL OR we.is_active = ${showActive}::BOOLEAN)
  `) as Row[];

  const total = Number(countRows[0]?.total ?? 0);

  const items = rows.map((row) => {
    const ld = row.last_delivery as Row | null;
    return mapWebhook(row, ld);
  });

  log.info('Admin: listed webhooks', { total, page, limit }, 'admin-webhook-service');

  return { items, total, page, limit };
}

export async function getAdminWebhookById(id: string): Promise<AdminWebhookDetail | null> {
  const rows = (await sql`
    SELECT we.*, c.name AS company_name
    FROM webhook_endpoints we
    JOIN companies c ON c.id = we.company_id
    WHERE we.id = ${id}::UUID
  `) as Row[];

  if (!rows[0]) return null;

  const deliveryRows = (await sql`
    SELECT * FROM webhook_deliveries
    WHERE webhook_id = ${id}::UUID
    ORDER BY delivered_at DESC
    LIMIT 20
  `) as Row[];

  const lastDel = deliveryRows[0] ?? null;
  const base = mapWebhook(rows[0]!, lastDel);

  return {
    ...base,
    deliveries: deliveryRows.map(mapDelivery),
  };
}

export interface UpdateWebhookParams {
  status?: 'active' | 'disabled';
  url?: string;
  events?: string[];
}

export async function updateAdminWebhook(
  id: string,
  updates: UpdateWebhookParams,
): Promise<AdminWebhook> {
  if (updates.status !== undefined) {
    const isActive = updates.status === 'active';
    await sql`
      UPDATE webhook_endpoints SET is_active = ${isActive}, failure_count = 0
      WHERE id = ${id}::UUID
    `;
  }
  if (updates.url !== undefined) {
    await sql`UPDATE webhook_endpoints SET url = ${updates.url} WHERE id = ${id}::UUID`;
  }
  if (updates.events !== undefined) {
    await sql`
      UPDATE webhook_endpoints SET events = ${updates.events}::TEXT[]
      WHERE id = ${id}::UUID
    `;
  }

  const rows = (await sql`
    SELECT we.*, c.name AS company_name
    FROM webhook_endpoints we
    JOIN companies c ON c.id = we.company_id
    WHERE we.id = ${id}::UUID
  `) as Row[];

  if (!rows[0]) throw new Error('Webhook not found after update');

  const lastDel = (await sql`
    SELECT id, success, delivered_at FROM webhook_deliveries
    WHERE webhook_id = ${id}::UUID ORDER BY delivered_at DESC LIMIT 1
  `) as Row[];

  log.info('Admin: updated webhook', { id, updates }, 'admin-webhook-service');
  return mapWebhook(rows[0]!, lastDel[0] ?? null);
}

export async function deleteAdminWebhook(id: string): Promise<void> {
  await sql`DELETE FROM webhook_endpoints WHERE id = ${id}::UUID`;
  log.info('Admin: deleted webhook', { id }, 'admin-webhook-service');
}

/**
 * Re-send a delivery of THIS webhook (the last failed one when no id is given)
 * through the tenant sender (deliverToEndpoint: signed, safeFetch, recorded,
 * stamped). The delivery is looked up within the webhook, so another webhook's
 * payload can never be sent or copied here. A disabled endpoint is refused.
 */
export async function redeliverWebhook(
  webhookId: string,
  deliveryId?: string,
): Promise<{ delivered: boolean; responseStatus: number | null; deliveryId: string }> {
  const endpoints = (await sql`SELECT * FROM webhook_endpoints WHERE id = ${webhookId}::UUID`) as Row[];
  const endpoint = endpoints[0];
  if (!endpoint) throw new Error('Webhook not found');
  if (!endpoint.is_active) throw new Error('This webhook is disabled. Enable it before redelivering.');

  const srcRows = (deliveryId
    ? await sql`
        SELECT id, event, payload FROM webhook_deliveries
        WHERE id = ${deliveryId}::UUID AND webhook_id = ${webhookId}::UUID`
    : await sql`
        SELECT id, event, payload FROM webhook_deliveries
        WHERE webhook_id = ${webhookId}::UUID AND success = false
        ORDER BY delivered_at DESC LIMIT 1`) as Row[];
  const src = srcRows[0];
  if (!src) throw new Error(deliveryId ? 'Delivery not found for this webhook' : 'No failed delivery found to redeliver');

  const payload = (typeof src.payload === 'string' ? JSON.parse(src.payload) : src.payload) as Record<string, unknown>;
  const result = await deliverToEndpoint(String(endpoint.company_id), endpoint, String(src.event), payload);
  log.info('Admin: redelivered webhook', {
    webhookId, originalDeliveryId: String(src.id), newDeliveryId: result.deliveryId,
    delivered: result.success, responseStatus: result.responseStatus,
  }, 'admin-webhook-service');
  return { delivered: result.success, responseStatus: result.responseStatus, deliveryId: result.deliveryId };
}
