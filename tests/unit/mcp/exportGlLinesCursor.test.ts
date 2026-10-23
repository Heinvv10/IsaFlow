/**
 * `export_gl_lines` cursors and fiscal basis, at unit level (PR #688 round 2:
 * these guards were protected only by *.int.test.ts suites, which `bun run ci`
 * and GitHub skip).
 *
 *  - A lines cursor is BOUND to the window it was issued for (date_from,
 *    date_to, status): it carries that window's row count and keyset, so a
 *    cursor reused with status "posted" reported the "all" count. Refused,
 *    before any query.
 *  - A table cursor carries a fixed kind and the row id — never a name — so a
 *    name of any length or script pages (a ~280-character name overflowed the
 *    512-character cursor and broke paging).
 *  - FY / FY_Period_No are the registry year holding the date (a stored year,
 *    else the template from the company's declared month, March when unset).
 *
 * `sql` is a data source here, not the thing under test: it serves rows and
 * honours the bound keyset; nothing asserts SQL text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-10-09T08:00:00.000Z'),
}));

import { exportGlLinesTool } from '@/lib/mcp/tools/exportGlLines';
import type { McpToolContext } from '@/lib/mcp/types';
import { fiscalYearSqlFake, type FakeYear } from '../../helpers/fiscalYearSqlFake';

const CO = '11111111-1111-4111-8111-111111111111';
const ctx = (scopes = ['read:reports']) => ({ userId: 'u1', companyId: CO, scopes, tokenJti: 'j', oauthAppId: 'a' } as McpToolContext);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Result = { isError?: boolean; content: Array<{ text: string }> };
const body = (r: unknown) => JSON.parse((r as Result).content[0]!.text) as Record<string, unknown>;
const decode = (c: unknown) => JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')) as string[];
const text = (call: unknown[]) => (Array.isArray(call[0]) ? (call[0] as string[]).join('$') : '');
const queries = () => sqlMock.mock.calls.length;

/** The month the registry's TEMPLATE year starts in (no year is stored here); null reads as March. */
let fyStart: number | null = 3;
/** Stored years for the registry (a transition year test sets these). */
let storedYears: readonly FakeYear[] = [];
const lines = Array.from({ length: 30 }, (_, i) => ({
  line_id: uuid(i + 1), entry_id: uuid(1000 + Math.floor(i / 2)), entry_date: '2026-04-01',
  debit: i % 2 === 0 ? 10 : 0, credit: i % 2 === 0 ? 0 : 10, entry_number: 'JE-1', source: 'manual', status: 'posted',
  account_code: '5000', account_name: 'acc',
}));
const longName = 'Ш'.repeat(400) + ' 株式会社 ' + 'ب'.repeat(400);
const parties = Array.from({ length: 7 }, (_, i) => ({
  k1: i < 4 ? 'Customer' : 'Supplier', id: uuid(500 + i), name: `${longName} ${i}`, type: i < 4 ? 'Customer' : 'Supplier', vat_number: null,
}));

beforeEach(() => {
  fyStart = 3;
  storedYears = [];
  sqlMock.mockReset();
  sqlMock.mockImplementation((strings: unknown, ...values: unknown[]) => {
    const t = Array.isArray(strings) ? (strings as string[]).join('$') : '';
    if (t.includes('AS row_count')) {
      return Promise.resolve([{ row_count: lines.length, posted_row_count: lines.length, txn_count: 15, control_total: '0.00',
        unbalanced_txn_count: 0, first_date: '2026-04-01', last_date: '2026-04-01' }]);
    }
    // The registry's database function, answered by the fake: stored years, else the declared month's template.
    if (t.includes('fiscal_year_for_date')) {
      return fiscalYearSqlFake(storedYears, { templateMonth: fyStart ?? 3 })(strings as TemplateStringsArray, ...values);
    }
    if (t.includes('FROM companies')) return Promise.resolve([{ name: 'Co' }]);
    if (t.includes('WITH page AS')) {
      const [cLine, limit] = [values[10] as string | null, values[11] as number];
      return Promise.resolve(lines.filter((l) => cLine === null || l.line_id > cLine).slice(0, limit));
    }
    if (t.includes('FROM suppliers s WHERE')) {
      // Bound: company x2, cursor id, cursor kind, cursor id, page size.
      const [cid, c1, limit] = [values[2] as string | null, values[3] as string | null, values[5] as number];
      return Promise.resolve(parties
        .filter((p) => cid === null || p.k1 > c1! || (p.k1 === c1 && p.id > cid))
        .slice(0, limit));
    }
    if (t.includes('AS n')) return Promise.resolve([{ n: parties.length }]);
    return Promise.resolve([]);
  });
});

describe('export_gl_lines: a lines cursor is bound to its window', () => {
  it('a cursor reused with another status or date is refused before any query', async () => {
    const first = body(await exportGlLinesTool.handler({ limit: 5 }, ctx()));
    const cursor = first.next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    for (const other of [{ status: 'posted' }, { date_from: '2026-04-01' }, { date_to: '2026-04-30' }]) {
      const before = queries();
      const r = (await exportGlLinesTool.handler({ limit: 5, cursor, ...other }, ctx())) as Result;
      expect(r.isError, JSON.stringify(other)).toBe(true);
      expect(r.content[0]!.text).toMatch(/cursor belongs to another date_from \/ date_to \/ status/);
      expect(queries(), JSON.stringify(other)).toBe(before);
    }
  });

  it('the same window pages on, and the cursor names that window', async () => {
    const args = { limit: 5, status: 'posted', date_from: '2026-04-01', date_to: '2026-04-30' };
    const first = body(await exportGlLinesTool.handler(args, ctx()));
    expect(decode(first.next_cursor)[2]).toBe('2026-04-01~2026-04-30~posted');
    const second = body(await exportGlLinesTool.handler({ ...args, cursor: first.next_cursor }, ctx()));
    expect(second.rowsTotal).toBe(30);
    expect((second.rows as unknown[]).length).toBe(5);
    expect(sqlMock.mock.calls.filter((c) => text(c).includes('AS row_count'))).toHaveLength(1);
  });
});

describe('export_gl_lines: a table cursor carries no user text', () => {
  it('names of any length and script page to exhaustion; the cursor is kind + id', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = body(await exportGlLinesTool.handler(
        { table: 'counterparties', limit: 2, ...(cursor ? { cursor } : {}) }, ctx(['read:reports', 'read:contacts'])));
      expect(r.completenessFault).toBeUndefined();
      for (const row of r.rows as string[][]) seen.push(row[0]!);
      cursor = (r.next_cursor as string | null) ?? undefined;
      if (cursor !== undefined) {
        expect(cursor.length).toBeLessThan(512);
        const [n, kind, id] = decode(cursor);
        expect(n).toBe('7');
        expect(['Customer', 'Supplier']).toContain(kind);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
      }
      pages++;
    } while (cursor !== undefined && pages < 20);
    expect(seen).toEqual(parties.map((p) => p.id));
  });

  it('a table cursor with a kind it never issues is refused', async () => {
    const forged = Buffer.from(JSON.stringify(['7', 'Zed', uuid(1)]), 'utf8').toString('base64url');
    const r = (await exportGlLinesTool.handler({ table: 'counterparties', cursor: forged }, ctx(['read:reports', 'read:contacts']))) as Result;
    expect(r.isError).toBe(true);
    expect(queries()).toBe(0);
  });
});

describe('export_gl_lines: FY is the registry year holding the date', () => {
  const fyOf = async () => {
    const r = body(await exportGlLinesTool.handler({ limit: 1 }, ctx()));
    const cols = r.columns as string[];
    const row = (r.rows as unknown[][])[0]!;
    return [row[cols.indexOf('FY')], row[cols.indexOf('FY_Period_No')]];
  };
  it('a stored 14-month transition year counts its months 1 to 14, whatever the declared month', async () => {
    fyStart = 3;
    storedYears = [{ fiscalYear: 2027, startDate: '2026-01-01', endDate: '2027-02-28' }];
    // The lines are dated 2026-04-01: month 4 of the stored year, labelled FY27.
    expect(await fyOf()).toEqual(['FY27', 4]);
  });

  it('a template year: July, January, and March when unset', async () => {
    fyStart = 7;
    expect(await fyOf()).toEqual(['FY26', 10]);
    fyStart = 1;
    expect(await fyOf()).toEqual(['FY26', 4]);
    fyStart = null;
    expect(await fyOf()).toEqual(['FY27', 2]);
    fyStart = 3;
    expect(await fyOf()).toEqual(['FY27', 2]);
  });
});
