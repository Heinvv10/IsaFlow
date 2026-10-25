/**
 * WS-1 (pentest M1): webhook signing secrets must be encrypted at rest, and
 * signing/testing must use the DECRYPTED secret — the old code signed deliveries
 * with mapWebhook's masked '••••••••'. testWebhook must also not echo the
 * upstream response body back to the caller (readable SSRF, H2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const sqlMock = vi.fn();
// Endpoint writes run on the migration_admin pool (S-07e part B): record its statements.
const admin = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }>, rows: [] as unknown[] }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (_label: string, fn: (c: unknown) => Promise<unknown>) => fn({
    query: async (text: string, values: unknown[]) => { admin.calls.push({ text, values }); return { rows: admin.rows }; },
  }),
}));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const safeFetchMock = vi.fn();
vi.mock('@/lib/safeFetch', () => ({ safeFetch: (...a: unknown[]) => safeFetchMock(...a) }));

import { createWebhook, testWebhook } from '@/modules/accounting/services/core/webhookService';
import { encryptToken, decryptToken } from '@/lib/encryption';

const KEY = 'test-encryption-key-0123456789-abcdef';

function row(secret: string | null) {
  return {
    id: 'wh-1', company_id: 'co-1', name: 'n', url: 'https://hook.example.com/x',
    secret, events: [], is_active: true, last_triggered_at: null,
    failure_count: 0, created_at: '2026-01-01',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  admin.calls.length = 0;
  process.env.ENCRYPTION_KEY = KEY;
});
afterEach(() => { delete process.env.ENCRYPTION_KEY; });

describe('createWebhook — secret encrypted at rest', () => {
  it('stores ciphertext, never the plaintext secret', async () => {
    admin.rows = [row('stored')];
    await createWebhook('co-1', {
      name: 'n', url: 'https://hook.example.com/x',
      secret: 'super-secret-value', events: ['invoice.created'],
    });
    const insert = admin.calls.find((c) => c.text.includes('INSERT INTO webhook_endpoints'));
    expect(insert).toBeTruthy();
    expect(sqlMock).not.toHaveBeenCalled();
    const stored = insert!.values.find(
      (v): v is string => typeof v === 'string' && v.split(':').length === 3,
    );
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('super-secret-value');
    expect(decryptToken(stored!)).toBe('super-secret-value');
  });
});

describe('testWebhook — signs with decrypted secret, hides upstream body', () => {
  it('computes X-Webhook-Signature from the real secret and does not leak the response body', async () => {
    const plaintext = 'hmac-signing-secret-xyz';
    sqlMock.mockResolvedValue([row(encryptToken(plaintext))]);
    safeFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'PRIVATE-UPSTREAM-BODY' });

    const result = await testWebhook('co-1', 'wh-1');

    const [, init] = safeFetchMock.mock.calls[0]!;
    const sentBody = (init as { body: string }).body;
    const sentSig = (init as { headers: Record<string, string> }).headers['X-Webhook-Signature'];
    expect(sentSig).toBe(crypto.createHmac('sha256', plaintext).update(sentBody).digest('hex'));
    expect(sentSig).not.toBe(crypto.createHmac('sha256', '••••••••').update(sentBody).digest('hex'));

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).not.toContain('PRIVATE-UPSTREAM-BODY');
  });
});
