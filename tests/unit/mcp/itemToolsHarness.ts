/**
 * Shared fixture for the item tool tests: a fake `sql` that answers the registry's audit / idempotency statements the way
 * mcp_tool_calls does (a key is stored only by a call that wrote; a dry run stores nothing under it) and records every
 * write the item services make, so a test can say "this refusal wrote nothing" and "this dry run wrote nothing".
 */
import { vi } from 'vitest';
import { sql } from '@/lib/neon';
import type { McpToolContext } from '@/lib/mcp/types';
import { refKey, type ExistingItem, type UpsertContext } from '@/modules/accounting/services/items/itemUpsertContext';

export const COMPANY = '22222222-2222-4222-8222-222222222222';
export const OTHER = '99999999-9999-4999-8999-999999999999';
export const ACC = '11111111-1111-4111-8111-111111111111';
export const CAT = '33333333-3333-4333-8333-333333333333';

export const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

export const ctxOf = (scopes: string[] = ['read:items', 'write:items']): McpToolContext => ({
  userId: '33333333-3333-4333-8333-333333333334', companyId: COMPANY, companyRole: 'owner', scopes, tokenJti: 'j', oauthAppId: null,
});

export const stored = (over: Partial<ExistingItem> & Pick<ExistingItem, 'id' | 'code'>): ExistingItem => ({
  deleted: false, description: 'Item', itemType: 'physical', unit: 'each', categoryId: null, purchasePrice: 0, salesPrice: 0,
  vatOnSales: 'standard', vatOnPurchases: 'standard', salesAccountId: null, purchasesAccountId: null, inventoryTracked: false,
  isActive: true, notes: null, externalSystem: null, externalRef: null, externalDocumentNumber: null, ...over,
});

export function upsertCtx(items: ExistingItem[] = [], movements: string[] = []): UpsertContext {
  return {
    byId: new Map(items.map((i) => [i.id, i])),
    byCode: new Map(items.map((i) => [i.code, i])),
    byRef: new Map(items.filter((i) => i.externalSystem && i.externalRef).map((i) => [refKey(i.externalSystem!, i.externalRef!), i])),
    categories: [{ id: CAT, code: 'optics', name: 'Optics', isActive: true }],
    accounts: new Map([[ACC, true]]),
    itemsWithMovements: new Set(movements),
  };
}

interface AuditRow { tool: string; key: string | null; hash: string; status: string; result: unknown }

export interface FakeDb {
  audit: AuditRow[];
  /** Statements that change items or item_categories. */
  writes: string[];
  /** Rows the fake answers for the named reads. */
  reads: Record<string, unknown[]>;
  nextId: number;
}

export function installFakeSql(): FakeDb {
  const db: FakeDb = { audit: [], writes: [], reads: {}, nextId: 1 };
  const id = () => `aaaaaaaa-0000-4000-8000-${String(db.nextId++).padStart(12, '0')}`;
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (strings: ReadonlyArray<string>, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('INSERT INTO mcp_tool_calls')) {
      const [, , , , tool, hash, key, status, result] = values as string[];
      const dup = key !== null && db.audit.some((a) => a.tool === tool && a.key === key);
      if (!dup) db.audit.push({ tool, key, hash, status, result: JSON.parse(result as string) });
      return [];
    }
    if (text.includes('FROM mcp_tool_calls')) {
      const [, tool, key] = values as string[];
      return db.audit.filter((a) => a.tool === tool && a.key === key && a.status === 'ok').map((a) => ({ result: a.result, args_hash: a.hash }));
    }
    if (text.includes('INSERT INTO items') || text.includes('INSERT INTO item_categories')) { db.writes.push(text); return [{ id: id() }]; }
    if (text.includes('UPDATE items') || text.includes('UPDATE item_categories')) {
      db.writes.push(text);
      return text.includes('RETURNING') ? [{ id: id() }] : [];
    }
    if (text.includes('COUNT(*)::INT AS n FROM items')) return db.reads.count ?? [{ n: 0 }];
    if (text.includes('FROM item_categories')) return db.reads.categories ?? [];
    if (text.includes('FROM items i')) return db.reads.items ?? [];
    if (text.includes('SELECT id, code, is_active FROM items')) return db.reads.deactivate ?? [];
    return [];
  });
  return db;
}

/**
 * Every statement an item tool sent to the catalogue tables (items, item_categories) that does NOT scope by the token's
 * company: `company_id = $n` in a WHERE, or company_id as the first INSERT column with the company bound. Row level
 * security would still hide another company's rows from the app role, so only a text check catches a query that forgot
 * the predicate the codebase requires on every statement.
 */
export function unscopedCatalogueStatements(companyId: string = COMPANY): string[] {
  const calls = (sqlMock as unknown as { mock: { calls: Array<[ReadonlyArray<string>, ...unknown[]]> } }).mock.calls;
  return calls
    .map(([strings, ...values]) => ({ text: strings.join('?'), values }))
    .filter(({ text }) => /\b(FROM|INTO|UPDATE)\s+(items|item_categories)\b/.test(text) && !text.includes('mcp_tool_calls'))
    .filter(({ text, values }) => !((/\bcompany_id\s*=\s*\?/.test(text) || /INSERT INTO \w+\s*\(\s*company_id/.test(text)) && values.includes(companyId)))
    .map(({ text }) => text.replace(/\s+/g, ' ').slice(0, 120));
}
