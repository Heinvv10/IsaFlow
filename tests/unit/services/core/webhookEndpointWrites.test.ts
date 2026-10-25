/**
 * S-07e part B (migration 946): webhook_endpoints create, update and delete run
 * on the migration_admin pool (no app role may INSERT, DELETE or UPDATE more than
 * the delivery stamps). The role bypasses RLS, so each statement must carry the
 * verified company itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[] }>,
  results: [] as unknown[][],
  tx: 0,
}));

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (label: string, fn: (c: unknown) => Promise<unknown>) => {
    h.tx += 1;
    return fn({
      query: async (text: string, values: unknown[]) => {
        h.admin.push({ label, text: text.replace(/\s+/g, ' ').trim(), values });
        return { rows: h.results.shift() ?? [] };
      },
    });
  },
}));

import { sql } from '@/lib/neon';
import { createWebhook, updateWebhook, deleteWebhook } from '@/modules/accounting/services/core/webhookService';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const endpointRow = (over: Record<string, unknown> = {}) => ({
  id: ID, company_id: COMPANY, name: 'n', url: 'https://hook.test/x', secret: null, events: ['invoice.sent'],
  is_active: true, last_triggered_at: null, failure_count: 0, created_at: '2026-01-01', ...over,
});

beforeEach(() => {
  h.admin.length = 0;
  h.results.length = 0;
  h.tx = 0;
  vi.mocked(sql).mockReset();
});

describe('webhook endpoint writes (migration_admin)', () => {
  it('createWebhook inserts with the company as the first bound value', async () => {
    h.results.push([endpointRow()]);
    const w = await createWebhook(COMPANY, { name: 'n', url: 'https://hook.test/x', events: ['invoice.sent'] });
    expect(w.id).toBe(ID);
    expect(h.admin).toHaveLength(1);
    expect(h.admin[0]!.text).toMatch(/^INSERT INTO webhook_endpoints \(company_id,/);
    expect(h.admin[0]!.values[0]).toBe(COMPANY);
    expect(h.admin[0]!.values).toContain(true); // is_active defaults on
    expect(sql).not.toHaveBeenCalled();
  });

  it('updateWebhook runs every field update and the re-read in ONE transaction, each keyed on id AND company', async () => {
    h.results.push([{ id: ID }], [{ id: ID }], [{ id: ID }], [{ id: ID }], [endpointRow({ name: 'x' })]);
    const w = await updateWebhook(COMPANY, ID, { name: 'x', url: 'https://hook.test/y', events: ['a'], isActive: false });
    expect(w.name).toBe('x');
    expect(h.tx).toBe(1);
    expect(h.admin).toHaveLength(5);
    for (const q of h.admin) {
      expect(q.text).toContain('company_id = $');
      expect(q.values).toContain(COMPANY);
      expect(q.values).toContain(ID);
    }
    expect(h.admin.map((q) => /SET (\w+)/.exec(q.text)?.[1])).toEqual(['name', 'url', 'events', 'is_active', undefined]);
    expect(sql).not.toHaveBeenCalled();
  });

  it('updateWebhook on another company\'s endpoint matches nothing and throws "not found"', async () => {
    h.results.push([]); // UPDATE ... RETURNING id: no row for this company
    await expect(updateWebhook(COMPANY, ID, { url: 'https://hook.test/y' })).rejects.toThrow(`Webhook not found: ${ID}`);
    expect(h.admin).toHaveLength(1); // stopped at the first refusal; no re-read
  });

  it('updateWebhook with no fields is a re-read and still throws when the endpoint is not the company\'s', async () => {
    h.results.push([]);
    await expect(updateWebhook(COMPANY, ID, {})).rejects.toThrow('Webhook not found');
    expect(h.admin[0]!.text).toMatch(/^SELECT \* FROM webhook_endpoints WHERE id = \$1::UUID AND company_id = \$2::UUID/);
  });

  it('updateWebhook stores a changed secret encrypted, and null clears it', async () => {
    process.env.ENCRYPTION_KEY = 'k'.repeat(36);
    h.results.push([{ id: ID }], [endpointRow()], [{ id: ID }], [endpointRow()]);
    await updateWebhook(COMPANY, ID, { secret: 'plain-secret' });
    expect(h.admin[0]!.values[0]).not.toBe('plain-secret');
    expect(String(h.admin[0]!.values[0]).split(':')).toHaveLength(3);
    h.admin.length = 0;
    await updateWebhook(COMPANY, ID, { secret: null });
    expect(h.admin[0]!.text).toContain('SET secret = $1');
    expect(h.admin[0]!.values[0]).toBeNull();
    delete process.env.ENCRYPTION_KEY;
  });

  it('deleteWebhook deletes by id AND company', async () => {
    await deleteWebhook(COMPANY, ID);
    expect(h.admin).toHaveLength(1);
    expect(h.admin[0]!.text).toBe('DELETE FROM webhook_endpoints WHERE id = $1::UUID AND company_id = $2::UUID');
    expect(h.admin[0]!.values).toEqual([ID, COMPANY]);
    expect(sql).not.toHaveBeenCalled();
  });
});
