/**
 * Webhook Service — WS-8.1
 * Fire-and-forget HMAC-signed webhook delivery with delivery logging.
 *
 * Endpoint create, update and delete, and fireWebhook's auto-disable, run on
 * the migration_admin pool (webhookEndpointWrites.ts; S-07e part B, migration
 * 946). The app pools keep only the delivery stamps on webhook_endpoints:
 * last_triggered_at and failure_count. webhook_deliveries stays app-writable.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import crypto from 'crypto';
import { safeFetch } from '@/lib/safeFetch';
import { encryptToken, decryptToken } from '@/lib/encryption';
import { WEBHOOK_EVENTS } from '@/modules/accounting/constants/webhookEvents';
import { insertEndpoint, updateEndpoint, deleteEndpoint, disableFailingEndpoint } from './webhookEndpointWrites';
type Row = DbRow;

/** Consecutive failures after which fireWebhook switches an endpoint off. */
const AUTO_DISABLE_AFTER_FAILURES = 10;

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
    secret: row.secret ? '••••••••' : null,
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
    payload: (row.payload !== null && typeof row.payload === 'object' ? row.payload : JSON.parse(typeof row.payload === 'string' ? row.payload : '{}')) as Record<string, unknown>,
    responseStatus: row.response_status != null ? Number(row.response_status) : null,
    responseBody: row.response_body ? String(row.response_body) : null,
    deliveredAt: String(row.delivered_at),
    success: Boolean(row.success),
  };
}

function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Read a stored signing secret. New rows are AES-GCM ciphertext (decryptToken);
 * legacy rows are plaintext. decryptToken throws on a non-ciphertext value that
 * merely *looks* 3-part (e.g. a legacy plaintext secret like `a:b:c`), so fall
 * back to the raw stored value rather than failing the delivery.
 */
function readStoredSecret(stored: string): string {
  try {
    return decryptToken(stored);
  } catch {
    return stored;
  }
}

/**
 * Fire webhook for an event — never throws to the caller.
 *
 * Awaitable on purpose (R-075). Its delivery-log INSERT and endpoint UPDATE run
 * AFTER an outbound fetch, so under a request transaction a detached call would
 * write on a connection the request had already committed and released. The
 * caller decides how to detach — `runAfterCommit` inside a request, a plain
 * un-awaited call outside one — and this function no longer decides for it.
 * Every statement carries company_id, so it is correct on the pool's role too.
 */
export async function fireWebhook(
  companyId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const rows = (await sql`
      SELECT * FROM webhook_endpoints
      WHERE company_id = ${companyId}
        AND is_active = true
        AND ${event} = ANY(events)
    `) as Row[];

    for (const row of rows) {
      const endpoint = mapWebhook(row);
      // Sign with the real (decrypted) secret — mapWebhook masks it, so the old
      // `endpoint.secret` signed every payload with the literal '••••••••'.
      const rawSecret = row.secret ? readStoredSecret(String(row.secret)) : null;
      const body = JSON.stringify(payload);
      const signature = rawSecret ? signPayload(rawSecret, body) : '';

      let responseStatus: number | null = null;
      let responseBody: string | null = null;
      let success = false;

      try {
        // safeFetch re-validates the (re-resolved) target on every delivery, so a
        // URL that now points to private space (rebinding) is refused fail-closed.
        const resp = await safeFetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': event,
            ...(signature ? { 'X-Webhook-Signature': signature } : {}),
          },
          body,
        });
        responseStatus = resp.status;
        responseBody = (await resp.text().catch(() => null))?.slice(0, 2000) ?? null;
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
          WHERE id = ${endpoint.id}::UUID AND company_id = ${companyId}
        `;
      } else {
        const stamped = (await sql`
          UPDATE webhook_endpoints
          SET failure_count = failure_count + 1
          WHERE id = ${endpoint.id}::UUID AND company_id = ${companyId}
          RETURNING failure_count
        `) as Row[];
        if (Number(stamped[0]?.failure_count ?? 0) >= AUTO_DISABLE_AFTER_FAILURES) {
          try {
            await disableFailingEndpoint(companyId, endpoint.id, AUTO_DISABLE_AFTER_FAILURES);
          } catch (disableErr) {
            // Stays on and is retried by the next failed delivery; the other endpoints still go out.
            log.error('Webhook auto-disable failed', { endpointId: endpoint.id, error: disableErr }, 'webhook');
          }
        }
      }
    }
  } catch (err) {
    log.error('fireWebhook error', { companyId, event, error: err }, 'webhook');
  }
}

/** Alias matching the spec name deliverWebhook — delegates to fireWebhook. */
export const deliverWebhook = fireWebhook;

export async function getWebhooks(companyId: string): Promise<Webhook[]> {
  const rows = (await sql`
    SELECT * FROM webhook_endpoints WHERE company_id = ${companyId} ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapWebhook);
}

export async function createWebhook(companyId: string, input: WebhookInput): Promise<Webhook> {
  // M1: encrypt the signing secret at rest (AES-256-GCM). Legacy plaintext rows
  // still decrypt transparently via decryptToken's 3-part-format check.
  const secretAtRest = input.secret ? encryptToken(input.secret) : null;
  const row = await insertEndpoint(companyId, {
    name: input.name,
    url: input.url,
    secretAtRest,
    events: input.events,
    isActive: input.isActive ?? true,
  });
  log.info('Webhook created', { id: row.id }, 'webhook');
  return mapWebhook(row);
}

export async function updateWebhook(
  companyId: string,
  id: string,
  updates: Partial<WebhookInput>,
): Promise<Webhook> {
  const row = await updateEndpoint(companyId, id, {
    name: updates.name,
    url: updates.url,
    secretAtRest: updates.secret === undefined ? undefined : updates.secret ? encryptToken(updates.secret) : null,
    events: updates.events,
    isActive: updates.isActive,
  });
  if (!row) throw new Error(`Webhook not found: ${id}`);
  log.info('Webhook updated', { id }, 'webhook');
  return mapWebhook(row);
}

export async function deleteWebhook(companyId: string, id: string): Promise<void> {
  await deleteEndpoint(companyId, id);
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
  const rawSecret = rows[0]!.secret ? readStoredSecret(String(rows[0]!.secret)) : null;

  const payload = { test: true, event: 'webhook.test', timestamp: new Date().toISOString() };
  const body = JSON.stringify(payload);
  const signature = rawSecret ? signPayload(rawSecret, body) : '';

  try {
    const resp = await safeFetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'webhook.test',
        ...(signature ? { 'X-Webhook-Signature': signature } : {}),
      },
      body,
    });
    log.info('Webhook test sent', { id, status: resp.status }, 'webhook');
    // H2: never return the upstream response body to the tenant (readable SSRF).
    // The status is enough to confirm the endpoint accepted the test.
    return {
      success: resp.ok,
      status: resp.status,
      body: resp.ok ? 'Endpoint responded successfully' : 'Endpoint returned a non-success status',
    };
  } catch (err) {
    log.warn('Webhook test failed', { id, error: err }, 'webhook');
    return { success: false, status: 0, body: err instanceof Error ? err.message : 'Request failed' };
  }
}
