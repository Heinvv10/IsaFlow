/**
 * export_gl_lines table=ap_open_items | ar_open_items | bank_accounts over MCP:
 * the table enum, the scope rule shared with the REST route, the control
 * summary on the FIRST page only, a keyset that visits every row exactly once
 * at any page size, a cursor that refuses a table that changed under it, and
 * the as-at-today tables refusing date_from / date_to / status.
 *
 * The table is built by a stand-in (the builders are tested in
 * tests/unit/services/reports/{openItems,bankAccounts}Export.test.ts); the
 * paging, cursor checks and envelope are the real code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const build = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/glExportComputedTables', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildComputedTable: build,
}));

import { GlExportScopeRefusal, exportGlLinesTool } from '@/lib/mcp/tools/exportGlLines';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = (scopes: string[]) => ({
  userId: 'u', companyId: '11111111-1111-4111-8111-111111111111', scopes, tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext);
const payload = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ROWS = [
  ...[1, 2].map((n) => ({ Doc_ID: uuid(n), Doc_Type: 'credit_note', Outstanding: -n })),
  ...[3, 4, 5, 6].map((n) => ({ Doc_ID: uuid(n), Doc_Type: 'invoice', Outstanding: n * 100 })),
  { Doc_ID: uuid(7), Doc_Type: 'unapplied_payment', Outstanding: -7 },
];
const SUMMARY = { table: 'ap_open_items', schemaVersion: 'isaflow-open-items-1.0', asAt: '2026-10-22', controlTotal: 1790, agedTotal: 1790, difference: 0 };

beforeEach(() => {
  build.mockReset().mockResolvedValue({ columns: ['Doc_ID', 'Doc_Type', 'Outstanding'], rows: ROWS, summary: SUMMARY });
});

describe('export_gl_lines computed tables', () => {
  it('lists the three tables in the enum', () => {
    const table = (exportGlLinesTool.inputSchema as { properties: { table: { enum: string[] } } }).properties.table;
    expect(table.enum).toEqual(expect.arrayContaining(['ap_open_items', 'ar_open_items', 'bank_accounts']));
    expect(exportGlLinesTool.scope).toBe('read:reports');
  });

  it('pages every row exactly once; the control summary comes with the first page only', async () => {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = payload(await exportGlLinesTool.handler(
        cursor === undefined ? { table: 'ap_open_items', limit: 3 } : { table: 'ap_open_items', limit: 3, cursor },
        ctx(['read:reports']),
      ));
      if (pages === 0) expect(body.summary).toEqual(SUMMARY);
      else expect(body.summary).toBeNull();
      expect(body.row_count).toBe(7);
      expect(body.columns).toEqual(['Doc_ID', 'Doc_Type', 'Outstanding']);
      seen.push(...(body.rows as unknown[][]).map((r) => r[0]));
      cursor = (body.next_cursor as string | null) ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(ROWS.map((r) => r.Doc_ID));
    expect(build).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'ap_open_items');
  });

  it('refuses a cursor that is not a [kind, id] it could have made, before building anything', async () => {
    const r = await exportGlLinesTool.handler({ table: 'ap_open_items', cursor: 'bm90LWEtY3Vyc29y' }, ctx(['read:reports']));
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(build).not.toHaveBeenCalled();
  });

  it('serves the open items on read:reports; bank_accounts needs read:bank-tx and counterparties read:contacts', async () => {
    for (const table of ['ap_open_items', 'ar_open_items']) {
      const r = await exportGlLinesTool.handler({ table }, ctx(['read:reports']));
      expect((r as { isError?: boolean }).isError).not.toBe(true);
    }
    for (const [table, scope, why] of [
      ['counterparties', 'read:contacts', 'VAT numbers'],
      ['bank_accounts', 'read:bank-tx', 'bank statement'],
    ] as const) {
      const err = await exportGlLinesTool.handler({ table }, ctx(['read:reports'])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GlExportScopeRefusal);
      expect((err as Error).message).toContain(scope);
      expect((err as Error).message).toContain(why);
    }
    expect(build).not.toHaveBeenCalledWith(expect.anything(), 'bank_accounts');
    const ok = await exportGlLinesTool.handler({ table: 'bank_accounts' }, ctx(['read:reports', 'read:bank-tx']));
    expect((ok as { isError?: boolean }).isError).not.toBe(true);
    expect(build).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'bank_accounts');
  });

  it('refuses date_from, date_to and status on an as-at-today table, before building anything', async () => {
    for (const extra of [{ date_from: '2026-01-01' }, { date_to: '2026-09-30' }, { status: 'posted' }]) {
      const r = await exportGlLinesTool.handler({ table: 'ar_open_items', ...extra }, ctx(['read:reports']));
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(r)).toContain('as at today');
    }
    expect(build).not.toHaveBeenCalled();
  });

  it('refuses a later page once the table has changed since the first: a posting, or a new as-at day', async () => {
    const first = payload(await exportGlLinesTool.handler({ table: 'ap_open_items', limit: 3 }, ctx(['read:reports'])));
    const cursor = first.next_cursor as string;
    for (const changed of [
      { rows: ROWS, summary: { ...SUMMARY, controlTotal: 1790.01 } },     // same rows, an amount moved
      { rows: ROWS.slice(1), summary: SUMMARY },                          // a row gone
      { rows: ROWS, summary: { ...SUMMARY, asAt: '2026-10-23' } },        // midnight passed
    ]) {
      build.mockResolvedValueOnce({ columns: ['Doc_ID', 'Doc_Type', 'Outstanding'], ...changed });
      const r = await exportGlLinesTool.handler({ table: 'ap_open_items', limit: 3, cursor }, ctx(['read:reports']));
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(r)).toContain('changed since the first page');
    }
    // Unchanged, the same cursor still serves the next page.
    const again = payload(await exportGlLinesTool.handler({ table: 'ap_open_items', limit: 3, cursor }, ctx(['read:reports'])));
    expect((again.rows as unknown[][]).map((r) => r[0])).toEqual(ROWS.slice(3, 6).map((r) => r.Doc_ID));
  });
});
