/**
 * `detail: "summary"` / `group_by` on list_supplier_invoices and list_invoices against real rows: for the same filters,
 * the summary's totals equal the sum of the rows the tool pages out and its groups equal those rows grouped. Company
 * B's rows (SECRET) are never counted, customers group by COALESCE(client_id, customer_id), and more than 200 groups
 * roll the remainder into `other` so the groups still sum to the totals.
 *
 * Rows: helpers/summaryFixture.ts. Disposable databases only - the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { listSupplierInvoicesTool } from '@/lib/mcp/tools/supplierInvoices';
import { listInvoicesTool } from '@/lib/mcp/tools/invoices';
import {
  FX, addUp, callTool, dropSummaryFixture, groupMap, seedSummaryFixture, sum, tally, type Group, type Json,
} from './helpers/summaryFixture';
import type { McpTool } from '@/lib/mcp/types';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;

describeIfDisposable('invoice list summaries against real rows', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const call = (tool: McpTool, args: Record<string, unknown>, company = FX.A): Promise<Json> => callTool(tool, args, company);

  beforeAll(async () => { await seedSummaryFixture(pool); }, 60_000);
  afterAll(async () => { await dropSummaryFixture(pool); await pool.end(); });

describe('list_supplier_invoices', () => {
  const FILTERS: Array<Record<string, unknown>> = [
    {}, { status: 'approved' }, { supplier_id: FX.sup.s1 }, { from_date: '2026-02-01', to_date: '2026-03-31' }, { search: 'MSL-SI-3' }, { status: 'cancelled' },
  ];
  async function pageAll(args: Record<string, unknown>, company = FX.A): Promise<Json[]> {
    const out: Json[] = [];
    for (let offset = 0; offset < 1000; offset += 4) {
      const body = await call(listSupplierInvoicesTool, { ...args, limit: 4, offset }, company);
      out.push(...(body.invoices as Json[]));
      if (out.length >= body.total) return out;
    }
    throw new Error('paging did not terminate');
  }
  const measures = {
    count: () => 1, total_amount: (r: Json) => Number(r.total_amount), amount_paid: (r: Json) => Number(r.amount_paid), balance: (r: Json) => Number(r.balance),
  };
  for (const raw of FILTERS) {
    it(`totals equal the paged rows and groups equal the rows grouped, for ${JSON.stringify(raw)}`, async () => {
      const rows = await pageAll(raw);
      const m = Object.keys(measures);
      const totals = (await call(listSupplierInvoicesTool, { ...raw, detail: 'summary' })).totals;
      expect(totals).toEqual(Object.fromEntries(m.map((k) => [k, k === 'count' ? rows.length : sum(rows.map(measures[k as keyof typeof measures]))])));
      for (const [by, keyOf] of [
        ['supplier', (r: Json) => String(r.supplier_id)], ['status', (r: Json) => String(r.status)], ['month', (r: Json) => String(r.invoice_date).slice(0, 7)],
      ] as const) {
        const body = await call(listSupplierInvoicesTool, { ...raw, group_by: by });
        addUp(body, m);
        expect(groupMap(body, m)).toEqual(tally(rows, keyOf, measures));
      }
    });
  }

  it('past 200 groups the rest is summed in `other`, so groups plus other still equal the totals', async () => {
    const body = await call(listSupplierInvoicesTool, { group_by: 'supplier' }, FX.C);
    expect(body.groups_total).toBe(230);
    expect(body.groups_returned).toBe(200);
    expect(body.other.count).toBe(30);
    addUp(body, ['count', 'total_amount', 'balance']);
    const all = await pageAll({}, FX.C);
    expect(body.totals.count).toBe(all.length);
    expect(body.totals.total_amount).toBe(sum(all.map((r) => Number(r.total_amount))));
    // Largest balances come first, so the 30 smallest are the remainder.
    expect(body.other.total_amount).toBe(sum(Array.from({ length: 30 }, (_, i) => 10 + i)));
  });

  it('counts company A only, and a default call is unchanged', async () => {
    expect(JSON.stringify(await call(listSupplierInvoicesTool, { group_by: 'supplier' }))).not.toContain('SECRET');
    const body = await call(listSupplierInvoicesTool, { limit: 2 });
    expect(Object.keys(body).sort()).toEqual(['invoices', 'offset', 'total']);
  });
});

describe('list_invoices', () => {
  const FILTERS: Array<Record<string, unknown>> = [
    {}, { status: 'sent' }, { status: 'overdue' }, { customer_id: FX.cus.c2 }, { search: 'MSL-INV-3' }, { search: 'Jane' },
  ];
  async function pageAll(args: Record<string, unknown>): Promise<Json[]> {
    const out: Json[] = [];
    let offset: number | null = 0;
    for (let i = 0; i < 100 && offset !== null; i++) {
      const body: Json = await call(listInvoicesTool, { ...args, limit: 3, offset });
      out.push(...(body.invoices as Json[]));
      offset = body.next_offset as number | null;
    }
    return out;
  }
  const bal = (r: Json): number => Number(r.total_amount ?? 0) - Number(r.amount_paid ?? 0);
  const measures = { count: () => 1, total_amount: (r: Json) => Number(r.total_amount), amount_paid: (r: Json) => Number(r.amount_paid), balance: bal };

  for (const raw of FILTERS) {
    it(`totals equal the paged rows and groups equal the rows grouped, for ${JSON.stringify(raw)}`, async () => {
      const rows = await pageAll(raw);
      const m = Object.keys(measures);
      const totals = (await call(listInvoicesTool, { ...raw, detail: 'summary' })).totals;
      expect(totals).toEqual(Object.fromEntries(m.map((k) => [k, k === 'count' ? rows.length : sum(rows.map(measures[k as keyof typeof measures]))])));
      for (const [by, keyOf] of [
        ['customer', (r: Json) => String(r.client_id)], ['status', (r: Json) => String(r.status)], ['month', (r: Json) => (r.invoice_date ? String(r.invoice_date).slice(0, 7) : '')],
      ] as const) {
        const body = await call(listInvoicesTool, { ...raw, group_by: by });
        addUp(body, m);
        expect(groupMap(body, m)).toEqual(tally(rows, keyOf, measures));
      }
    });
  }

  it('groups customers by COALESCE(client_id, customer_id), names them, counts A only; a default call is unchanged', async () => {
    const body = await call(listInvoicesTool, { group_by: 'customer' });
    expect((body.groups as Group[]).map((g) => g.label).sort()).toEqual(['Jane', 'John']);
    expect(JSON.stringify(body)).not.toContain('SECRET');
    const plain = await call(listInvoicesTool, { limit: 2 });
    expect(Object.keys(plain).sort()).toEqual(['invoices', 'next_offset', 'total']);
  });
});
});
