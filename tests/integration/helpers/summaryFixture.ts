/**
 * Rows for the MCP summary suites (mcp-summaries-bank / mcp-summaries-invoices): three companies, a spread of bank
 * lines in every allocation state, bills, customer invoices, and 230 suppliers in company C for the group cap.
 * Company B carries SECRET rows that no summary of A may count. Inserted with session_replication_role = replica
 * (the bank lines name journal lines that do not exist). Disposable databases only.
 */
import type { Pool } from 'pg';
import { expect } from 'vitest';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

export const cents = (n: number): number => Math.round(n * 100) / 100;
export const sum = (xs: number[]): number => cents(xs.reduce((a, b) => a + b, 0));
const id = (): string => crypto.randomUUID();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
export interface Group { key: string; label: string | null; [m: string]: number | string | null }

export interface SummaryFixture {
  A: string; B: string; C: string; user: string;
  acc: Record<'a1' | 'a2' | 'b1' | 'cat', string>;
  sup: Record<'s1' | 's2' | 's3' | 'sb', string>;
  cus: Record<'c1' | 'c2' | 'cb', string>;
}

/** The ids are fixed at import so a suite can build its filter lists at describe time; every suite process draws its own. */
export const FX: SummaryFixture = {
  A: id(), B: id(), C: id(), user: id(),
  acc: { a1: id(), a2: id(), b1: id(), cat: id() },
  sup: { s1: id(), s2: id(), s3: id(), sb: id() },
  cus: { c1: id(), c2: id(), cb: id() },
};

export async function callTool(tool: McpTool, args: Record<string, unknown>, company = FX.A): Promise<Json> {
  const ctx: McpToolContext = { userId: FX.user, companyId: company, scopes: ['read:bank-tx', 'read:invoices'], tokenJti: 'j', oauthAppId: null };
  const res = await tool.handler(args, ctx);
  if (res.isError) throw new Error(`${tool.name}: ${res.content[0]!.text}`);
  return JSON.parse(res.content[0]!.text) as Json;
}

/** The groups (plus `other`) add up to the totals, measure by measure. */
export function addUp(body: Json, measures: string[]): void {
  const groups = body.groups as Group[];
  expect(body.groups_returned).toBe(groups.length);
  for (const m of measures) {
    const parts = groups.map((g) => Number(g[m])).concat(body.other ? [Number(body.other[m])] : []);
    expect(sum(parts)).toBe(cents(Number(body.totals[m])));
  }
}

/** Group rows by `keyOf` and sum each measure: the oracle a summary's groups are compared to. */
export function tally(
  rows: Json[], keyOf: (r: Json) => string, measures: Record<string, (r: Json) => number>,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const e = out.get(keyOf(r)) ?? Object.fromEntries(Object.keys(measures).map((m) => [m, 0]));
    for (const [m, fn] of Object.entries(measures)) e[m] = cents(e[m]! + fn(r));
    out.set(keyOf(r), e);
  }
  return out;
}

export function groupMap(body: Json, measures: string[]): Map<string, Record<string, number>> {
  return new Map((body.groups as Group[]).map((g) => [g.key, Object.fromEntries(measures.map((m) => [m, Number(g[m])]))]));
}

export async function seedSummaryFixture(pool: Pool): Promise<void> {
  const { A, B, C, user, acc, sup, cus } = FX;
  const client = await pool.connect();
  const q = (text: string, params: unknown[] = []) => client.query(text, params);
  try {
    await q('BEGIN');
    await q('SET LOCAL session_replication_role = replica');
    for (const [cid, name] of [[A, 'MSL A'], [B, 'MSL B SECRET'], [C, 'MSL C']] as const) {
      await q('INSERT INTO companies(id, name, financial_year_start) VALUES ($1,$2,3)', [cid, name]);
    }
    for (const [aid, co, code, name, sub] of [
      [acc.a1, A, '1000', 'Main bank', 'bank'], [acc.a2, A, '1010', 'Savings', 'bank'], [acc.b1, B, '1000', 'B bank SECRET', 'bank'],
      [acc.cat, A, '6000', 'Opex', null],
    ] as const) {
      await q(`INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`, [aid, co, code, name, sub === 'bank' ? 'asset' : 'expense', sub, 'debit']);
    }
    for (const [sid, co, name] of [[sup.s1, A, 'Acme'], [sup.s2, A, 'Beta'], [sup.s3, A, 'Gamma'], [sup.sb, B, 'B SECRET SUPPLIER']] as const) {
      await q('INSERT INTO suppliers(id, company_id, name) VALUES ($1,$2,$3)', [sid, co, name]);
    }
    for (const [cid, co, name] of [[cus.c1, A, 'Jane'], [cus.c2, A, 'John'], [cus.cb, B, 'B SECRET CUSTOMER']] as const) {
      await q('INSERT INTO customers(id, company_id, name) VALUES ($1,$2,$3)', [cid, co, name]);
    }

    // Bank lines: every allocation state, two accounts, four months, two companies, one removed feed line.
    const tx: Array<[string, string, string, number, string, Record<string, unknown>]> = [];
    const months = ['2026-01-15', '2026-02-10', '2026-03-05', '2026-04-20'];
    months.forEach((d, i) => {
      tx.push([A, acc.a1, d, 100 + i, `MSL salary ${i}`, { matched: true, status: 'allocated' }]);
      tx.push([A, acc.a1, d, -(50 + i), `MSL 50% promo ${i}`, { suggestGl: true }]);
      tx.push([A, acc.a2, d, -(20.25 + i), `MSL 50 promo ${i}`, { suggestSupplier: true }]);
      tx.push([A, acc.a2, d, 7.5 + i, `MSL plain ${i}`, {}]);
      tx.push([A, acc.a1, d, -3.33, `MSL excluded ${i}`, { status: 'excluded' }]);
      tx.push([A, acc.a2, d, 12.1, `MSL typed ${i}`, { allocationType: 'account' }]);
    });
    // Excluded AFTER being suggested / allocated: the state ladder is matched > excluded > suggested.
  tx.push([A, acc.a1, '2026-02-03', -61, 'MSL excluded but suggested', { status: 'excluded', suggestGl: true }]);
  tx.push([A, acc.a2, '2026-03-03', 62, 'MSL excluded but matched', { status: 'excluded', matched: true }]);
  tx.push([A, acc.a1, '2026-02-02', 999, 'MSL removed', { removed: true }]);
    tx.push([B, acc.b1, '2026-02-02', 4242, 'MSL B SECRET', {}]);
    for (const [co, ba, date, amount, desc, o] of tx) {
      await q(`INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, feed_state,
                 bank_feed_connection_id, provider_transaction_id, matched_journal_line_id, suggested_gl_account_id,
                 suggested_supplier_id, allocation_type)
               VALUES ($1,$2,$3::DATE,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [co, ba, date, amount, desc, (o.status as string) ?? 'imported', o.removed ? 'removed' : 'posted',
          o.removed ? id() : null, o.removed ? 'p-1' : null, o.matched ? id() : null,
          o.suggestGl ? acc.cat : null, o.suggestSupplier ? sup.s1 : null, (o.allocationType as string) ?? null]);
    }

    // Bills: three suppliers, several statuses and months, plus B's.
    const bills: Array<[string, string, string, string, number, number]> = [
      [A, sup.s1, 'approved', '2026-01-10', 1000, 0], [A, sup.s1, 'paid', '2026-02-11', 500, 500], [A, sup.s2, 'partially_paid', '2026-02-20', 800.55, 300.1],
      [A, sup.s2, 'draft', '2026-03-01', 120.2, 0], [A, sup.s3, 'cancelled', '2026-03-15', 77.77, 0], [A, sup.s3, 'approved', '2026-04-01', 2500, 100],
      [A, sup.s1, 'approved', '2026-04-02', 41.41, 0], [B, sup.sb, 'approved', '2026-02-02', 9999, 0],
    ];
    for (const [i, [co, s, status, date, total, paid]] of bills.entries()) {
      await q(`INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, created_by, status, subtotal, total_amount, amount_paid)
               VALUES ($1,$2,$3,$4::DATE,$5,$6,$7,$7,$8)`, [co, `MSL-SI-${i}`, s, date, user, status, total, paid]);
    }
    // The cap: 230 suppliers, one bill each, in company C.
    for (let i = 0; i < 230; i++) {
      const sid = id();
      await q('INSERT INTO suppliers(id, company_id, name) VALUES ($1,$2,$3)', [sid, C, `Big ${String(i).padStart(3, '0')}`]);
      await q(`INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, created_by, status, subtotal, total_amount, amount_paid)
               VALUES ($1,$2,$3,'2026-03-01',$4,'approved',$5,$5,0)`, [C, `MSL-BIG-${i}`, sid, user, 10 + i]);
    }

    // Customer invoices: client_id set on some, only customer_id on others (COALESCE), a null invoice_date.
    const inv: Array<[string, string, string | null, string, string | null, number, number]> = [
      [A, cus.c1, cus.c1, 'sent', '2026-01-05', 1150, 0], [A, cus.c1, null, 'paid', '2026-01-25', 230, 230], [A, cus.c2, cus.c2, 'partially_paid', '2026-02-14', 575, 100],
      [A, cus.c2, null, 'draft', '2026-03-03', 69, 0], [A, cus.c1, cus.c2, 'sent', '2026-03-30', 345.5, 0], [A, cus.c2, null, 'cancelled', null, 10, 0],
      [B, cus.cb, null, 'sent', '2026-02-02', 8888, 0],
    ];
    for (const [i, [co, customer, client, status, date, total, paid]] of inv.entries()) {
      await q(`INSERT INTO customer_invoices(company_id, invoice_number, customer_id, client_id, created_by, status, invoice_date, subtotal, total_amount, amount_paid)
               VALUES ($1,$2,$3,$4,'msl',$5,$6::DATE,$7,$7,$8)`, [co, `MSL-INV-${i}`, customer, client, status, date, total, paid]);
    }
    await q('COMMIT');
    // The view the invoice list joins is created WITH NO DATA (a fresh cluster has never refreshed it).
    await q('REFRESH MATERIALIZED VIEW public.customer_invoice_view_summary_mv');
  } catch (err) {
    await q('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function dropSummaryFixture(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    for (const t of ['bank_transactions', 'supplier_invoices', 'customer_invoices', 'suppliers', 'customers', 'gl_accounts']) {
      await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::UUID[])`, [[FX.A, FX.B, FX.C]]);
    }
    await client.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [[FX.A, FX.B, FX.C]]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
