/**
 * Admin Webhook Service
 * Cross-company webhook management for super_admin use.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

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

export async function redeliverWebhook(
  webhookId: string,
  deliveryId?: string,
): Promise<{ queued: boolean; deliveryId: string }> {
  let targetDeliveryId = deliveryId;

  if (!targetDeliveryId) {
    const rows = (await sql`
      SELECT id FROM webhook_deliveries
      WHERE webhook_id = ${webhookId}::UUID AND success = false
      ORDER BY delivered_at DESC
      LIMIT 1
    `) as Row[];
    if (!rows[0]) throw new Error('No failed delivery found to redeliver');
    targetDeliveryId = String(rows[0].id);
  }

  // Mark delivery as pending redeliver by inserting a clone with success=false
  const srcRows = (await sql`
    SELECT * FROM webhook_deliveries WHERE id = ${targetDeliveryId}::UUID
  `) as Row[];
  if (!srcRows[0]) throw new Error('Delivery not found');

  const src = srcRows[0]!;
  const payloadJson = typeof src.payload === 'string'
    ? src.payload
    : JSON.stringify(src.payload);

  const newRows = (await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, success)
    VALUES (${webhookId}::UUID, ${String(src.event)}, ${payloadJson}::JSONB, false)
    RETURNING id
  `) as Row[];

  const newId = String(newRows[0]!.id);
  log.info('Admin: queued webhook redeliver', { webhookId, originalDeliveryId: targetDeliveryId, newDeliveryId: newId }, 'admin-webhook-service');

  return { queued: true, deliveryId: newId };
}
