/**
 * Webhook Service — WS-8.1
 * Fire-and-forget HMAC-signed webhook delivery with delivery logging.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import crypto from 'crypto';
import { WEBHOOK_EVENTS } from '@/modules/accounting/constants/webhookEvents';
type Row = any;

export { WEBHOOK_EVENTS };
export type { WebhookEvent } from '@/modules/accounting/constants/webhookEvents';


export interface Webhook {
  id: string;
  companyId: string;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  isActive: boolean;
  lastTriggeredAt: string | null;
  failureCount: number;
  createdAt: string;
}

export interface WebhookInput {
  name: string;
  url: string;
  secret?: string | null;
  events: string[];
  isActive?: boolean;
}

export interface Delivery {
  id: string;
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  responseStatus: number | null;
  responseBody: string | null;
  deliveredAt: string;
  success: boolean;
}

function mapWebhook(row: Row): Webhook {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    url: String(row.url),
    secret: row.secret ? String(row.secret) : null,
    events: Array.isArray(row.events) ? row.events : [],
    isActive: Boolean(row.is_active),
    lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
    failureCount: Number(row.failure_count),
    createdAt: String(row.created_at),
  };
}

function mapDelivery(row: Row): Delivery {
  return {
    id: String(row.id),
    webhookId: String(row.webhook_id),
    event: String(row.event),
    payload: typeof row.payload === 'object' ? row.payload : JSON.parse(row.payload || '{}'),
    responseStatus: row.response_status != null ? Number(row.response_status) : null,
    responseBody: row.response_body ? String(row.response_body) : null,
    deliveredAt: String(row.delivered_at),
    success: Boolean(row.success),
  };
}

function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Fire webhook for an event — non-blocking, never throws to caller. */
export async function fireWebhook(
  companyId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Intentionally fire-and-forget — wrap everything in try/catch
  void (async () => {
    try {
      const rows = (await sql`
        SELECT * FROM webhook_endpoints
        WHERE company_id = ${companyId}
          AND is_active = true
          AND ${event} = ANY(events)
      `) as Row[];

      for (const row of rows) {
        const endpoint = mapWebhook(row);
        const body = JSON.stringify(payload);
        const signature = endpoint.secret ? signPayload(endpoint.secret, body) : '';

        let responseStatus: number | null = null;
        let responseBody: string | null = null;
        let success = false;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const resp = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Event': event,
              ...(signature ? { 'X-Webhook-Signature': signature } : {}),
            },
            body,
            signal: controller.signal,
          });
          clearTimeout(timeout);
          responseStatus = resp.status;
          responseBody = await resp.text().catch(() => null);
          success = resp.ok;
        } catch (fetchErr) {
          log.warn('Webhook delivery failed', { endpointId: endpoint.id, error: fetchErr }, 'webhook');
        }

        // Record delivery
        await sql`
          INSERT INTO webhook_deliveries (webhook_id, event, payload, response_status, response_body, success)
          VALUES (${endpoint.id}::UUID, ${event}, ${JSON.stringify(payload)}::JSONB,
                  ${responseStatus}, ${responseBody}, ${success})
        `;

        if (success) {
          await sql`
            UPDATE webhook_endpoints
            SET last_triggered_at = NOW(), failure_count = 0
            WHERE id = ${endpoint.id}::UUID
          `;
        } else {
          await sql`
            UPDATE webhook_endpoints
            SET failure_count = failure_count + 1,
                is_active = CASE WHEN failure_count + 1 >= 10 THEN false ELSE is_active END
            WHERE id = ${endpoint.id}::UUID
          `;
        }
      }
    } catch (err) {
      log.error('fireWebhook error', { companyId, event, error: err }, 'webhook');
    }
  })();
}

export async function getWebhooks(companyId: string): Promise<Webhook[]> {
  const rows = (await sql`
    SELECT * FROM webhook_endpoints WHERE company_id = ${companyId} ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapWebhook);
}

export async function createWebhook(companyId: string, input: WebhookInput): Promise<Webhook> {
  const rows = (await sql`
    INSERT INTO webhook_endpoints (company_id, name, url, secret, events, is_active)
    VALUES (${companyId}, ${input.name}, ${input.url}, ${input.secret ?? null},
            ${JSON.stringify(input.events)}::TEXT[], ${input.isActive ?? true})
    RETURNING *
  `) as Row[];
  log.info('Webhook created', { id: rows[0]?.id }, 'webhook');
  return mapWebhook(rows[0]!);
}

export async function updateWebhook(
  companyId: string,
  id: string,
  updates: Partial<WebhookInput>,
): Promise<Webhook> {
  // Build individual field updates to avoid array casting complexity
  if (updates.name !== undefined) {
    await sql`UPDATE webhook_endpoints SET name = ${updates.name} WHERE id = ${id}::UUID AND company_id = ${companyId}`;
  }
  if (updates.url !== undefined) {
    await sql`UPDATE webhook_endpoints SET url = ${updates.url} WHERE id = ${id}::UUID AND company_id = ${companyId}`;
  }
  if (updates.secret !== undefined) {
    await sql`UPDATE webhook_endpoints SET secret = ${updates.secret ?? null} WHERE id = ${id}::UUID AND company_id = ${companyId}`;
  }
  if (updates.events !== undefined) {
    await sql`UPDATE webhook_endpoints SET events = ${updates.events}::TEXT[] WHERE id = ${id}::UUID AND company_id = ${companyId}`;
  }
  if (updates.isActive !== undefined) {
    await sql`UPDATE webhook_endpoints SET is_active = ${updates.isActive} WHERE id = ${id}::UUID AND company_id = ${companyId}`;
  }
  const rows = (await sql`
    SELECT * FROM webhook_endpoints WHERE id = ${id}::UUID AND company_id = ${companyId}
  `) as Row[];
  if (!rows[0]) throw new Error('Webhook not found');
  log.info('Webhook updated', { id }, 'webhook');
  return mapWebhook(rows[0]!);
}

export async function deleteWebhook(companyId: string, id: string): Promise<void> {
  await sql`DELETE FROM webhook_endpoints WHERE id = ${id}::UUID AND company_id = ${companyId}`;
  log.info('Webhook deleted', { id }, 'webhook');
}

export async function getDeliveries(
  companyId: string,
  webhookId: string,
  limit = 50,
): Promise<Delivery[]> {
  // Verify ownership
  const rows = (await sql`
    SELECT wd.* FROM webhook_deliveries wd
    JOIN webhook_endpoints we ON we.id = wd.webhook_id
    WHERE wd.webhook_id = ${webhookId}::UUID AND we.company_id = ${companyId}
    ORDER BY wd.delivered_at DESC
    LIMIT ${limit}
  `) as Row[];
  return rows.map(mapDelivery);
}

export async function testWebhook(
  companyId: string,
  id: string,
): Promise<{ success: boolean; status: number; body: string }> {
  const rows = (await sql`
    SELECT * FROM webhook_endpoints WHERE id = ${id}::UUID AND company_id = ${companyId}
  `) as Row[];
  if (!rows[0]) throw new Error('Webhook not found');
  const endpoint = mapWebhook(rows[0]!);

  const payload = { test: true, event: 'webhook.test', timestamp: new Date().toISOString() };
  const body = JSON.stringify(payload);
  const signature = endpoint.secret ? signPayload(endpoint.secret, body) : '';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'webhook.test',
        ...(signature ? { 'X-Webhook-Signature': signature } : {}),
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const respBody = await resp.text().catch(() => '');
    log.info('Webhook test sent', { id, status: resp.status }, 'webhook');
    return { success: resp.ok, status: resp.status, body: respBody };
  } catch (err) {
    log.warn('Webhook test failed', { id, error: err }, 'webhook');
    return { success: false, status: 0, body: err instanceof Error ? err.message : 'Request failed' };
  }
}
