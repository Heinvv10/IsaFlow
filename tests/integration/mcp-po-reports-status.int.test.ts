/**
 * po_status_report (docs/design/mcp-po-reports.md, tests 3, 4 and 5), real PostgreSQL, through the real registry as app_user:
 *   - per PO, billed and received are what get_purchase_order reports for the same PO (the one attribution; lines' quantity_received), and
 *     committed is the PO-level committed engine's figure; ages and outstanding are worked by hand; a cancelled goods received note is not
 *     counted as received (once the schema has 1021's status: see the skipIf below);
 *   - another company's POs never appear, for a user who belongs to both companies;
 *   - filters, ordering (oldest first, then PO number) and paging walk every PO once.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips but the one named case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture } from './helpers/budgetBillFixture';
import { body, mcp, text } from './helpers/mcpBudgetFixture';
import { mkGrn, mkPo, seedWorld, type SeededPo, type World } from './helpers/poReportsWorld';
import { poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let w: World;
let other: World;
let recv: SeededPo;
let cancelledGrnPo: SeededPo | null = null;
let hasCancelledStatus = false;

interface Bill { bill_id: string; invoice_number: string; status: string; attributed_via: string; attributed_amount: string; invoice_date: string; counts_as_billed: boolean; deleted: boolean }
interface Item {
  id: string; po_number: string; supplier: { id: string; name: string }; status: string; closed_from_status: string | null; closed_by_billing: boolean; order_date: string; age_days: number;
  ordered: string; received: string; billed: string; outstanding: string; committed: string; last_receipt_date: string | null; days_since_last_receipt: number | null;
  last_bill_date: string | null; days_since_last_bill: number | null; bills: Bill[]; bills_total: number;
}
interface Out { items: Item[]; total: number; next_offset: number | null }

const INV = { role: 'owner', scopes: ['read:invoices'] };
const report = async (args: Record<string, unknown> = {}, u = w.u) => body(await mcp(pool, u, 'po_status_report', { limit: 100, ...args }, INV)) as unknown as Out;
const detail = async (po: string) => body(await mcp(pool, w.u, 'get_purchase_order', { po_id: po }, INV)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const cents = (v: string | number) => Math.round(Number(v) * 100);
const money = (c: number) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
/** Whole days from `date` (YYYY-MM-DD) to today's calendar day in Johannesburg. */
const sast = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' });
const daysSince = (date: string) => Math.round((Date.parse(sast.format(new Date())) - Date.parse(date)) / 86_400_000);
const find = (out: Out, po: SeededPo) => out.items.find((i) => i.id === po.po)!;

beforeAll(async () => {
  w = await seedWorld(pool, 'po-rep-s-a');
  other = await seedWorld(pool, 'po-rep-s-b');
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [other.f.co, w.f.owner]);
  const acct = w.f.acc.opex;
  // Line 0: 10 ordered at 5, 4 received. Line 1: 4 ordered at 25, 6 received (over-received: counts 4 x 25).
  recv = await mkPo(pool, w.f, { month: '2026-05', status: 'partially_received', lines: [{ acct, qty: 10, price: 5, received: 4 }, { acct, qty: 4, price: 25, received: 6 }] });
  await mkGrn(pool, w.f, recv, [[recv.items[0]!, 3]], '2026-05-20');
  await mkGrn(pool, w.f, recv, [[recv.items[0]!, 1], [recv.items[1]!, 6]], '2026-06-10');
  const def = (await pool.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'goods_received_notes_status_check'")).rows[0]?.d as string | undefined;
  hasCancelledStatus = !!def && def.includes('cancelled');
  if (hasCancelledStatus) {
    // As 1021's goods_received_note_cancel leaves it: the note cancelled and its quantities taken back off the PO line.
    cancelledGrnPo = await mkPo(pool, w.f, { month: '2026-05', status: 'partially_received', lines: [{ acct, qty: 10, price: 5, received: 3 }] });
    await mkGrn(pool, w.f, cancelledGrnPo, [[cancelledGrnPo.items[0]!, 3]], '2026-05-21');
    const dead = await mkGrn(pool, w.f, cancelledGrnPo, [[cancelledGrnPo.items[0]!, 7]], '2026-06-30');
    await pool.query("UPDATE goods_received_notes SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'wrong delivery' WHERE id = $1", [dead, w.f.owner]);
  }
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.f.co, w.f.owner]);
    for (const x of [w, other]) {
      await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [x.f.co]);
      await pool.query('DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_received_notes WHERE company_id = $1)', [x.f.co]);
      await pool.query('DELETE FROM goods_received_notes WHERE company_id = $1', [x.f.co]);
      await dropBillFixture(pool, x.f);
    }
  } finally { await pool.end(); }
}, 120_000);

describe('billed and received are what get_purchase_order reports', () => {
  it('for every PO of the world', async () => {
    const out = await report();
    const all = [...Object.values(w.po), recv, ...(cancelledGrnPo ? [cancelledGrnPo] : [])];
    expect(out.items.map((i) => i.id).sort()).toEqual(all.map((p) => p.po).sort());
    const committed = await poCommittedByIds(all);
    for (const po of all) {
      const mine = find(out, po);
      const theirs = await detail(po.po);
      const lines = theirs.lines as Array<{ quantity_ordered: number; quantity_received: number; unit_price: number; line_total: number }>;
      const received = lines.reduce((s, l) => s + Math.round(Math.min(l.quantity_received, l.quantity_ordered) * l.unit_price * 100), 0);
      expect(cents(mine.billed), `${mine.po_number} billed`).toBe(cents(theirs.billed_total));
      expect(cents(mine.received), `${mine.po_number} received`).toBe(received);
      expect(cents(mine.ordered), `${mine.po_number} ordered`).toBe(lines.reduce((s, l) => s + cents(l.line_total), 0));
      expect(cents(mine.committed), `${mine.po_number} committed`).toBe(committed.get(po.po.toLowerCase()) ?? 0);
      expect(mine.bills_total, `${mine.po_number} bills`).toBe(theirs.bills_total);
      expect(mine.bills.map((b) => [b.bill_id, b.counts_as_billed, cents(b.attributed_amount)]).sort())
        .toEqual((theirs.bills as Array<Record<string, any>>).map((b) => [b.bill_id, b.counts_as_billed, cents(b.attributed_amount)]).sort()); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  });

  it('billed through lines, a header only, a negative line and a close by billing, worked by hand', async () => {
    const out = await report();
    const row = (po: SeededPo) => { const i = find(out, po); return [i.ordered, i.billed, i.outstanding, i.committed]; };
    expect(row(w.po.partial!)).toEqual(['300.00', '40.00', '260.00', '260.00']);
    expect(row(w.po.header!)).toEqual(['300.00', '120.00', '180.00', '180.00']);
    expect(row(w.po.negative!)).toEqual(['200.00', '70.00', '130.00', '130.00']);
    expect(row(w.po.closedUnder!)).toEqual(['400.00', '150.00', '250.00', '250.00']);
    expect(row(w.po.cancelled!)).toEqual(['250.00', '0.00', '250.00', '0.00']);
    expect(row(w.po.shortClosed!)).toEqual(['175.00', '0.00', '175.00', '0.00']);
    expect(find(out, w.po.closedUnder!)).toMatchObject({ status: 'closed', closed_by_billing: true, closed_from_status: null });
    expect(find(out, w.po.shortClosed!)).toMatchObject({ status: 'closed', closed_by_billing: false, closed_from_status: 'approved' });
  });

  it('the committed of all POs adds up to committed_spend, account-less included', async () => {
    const out = await report({ from: '2026-06-01', to: '2026-06-30' });
    const sum = out.items.reduce((s, i) => s + cents(i.committed), 0);
    const spend = body(await mcp(pool, w.u, 'committed_spend', { from_month: '2026-06', to_month: '2026-06', group_by: [] }, { role: 'owner', scopes: ['read:reports'] })) as
      { total: { committed: string }; no_account: { committed: string } };
    expect(sum).toBe(cents(spend.total.committed) + cents(spend.no_account.committed));
  });
});

describe('ages, bills and receipts', () => {
  it('age_days, days since the last bill and the bills list (number, status, attributed amount, date)', async () => {
    const out = await report();
    const partial = find(out, w.po.partial!);
    expect(partial.age_days).toBe(daysSince('2026-06-02'));
    expect(partial.last_bill_date).toBe('2026-06-15');
    expect(partial.days_since_last_bill).toBe(daysSince('2026-06-15'));
    expect(partial.bills).toEqual([expect.objectContaining({ bill_id: w.bills.partial, status: 'approved', attributed_via: 'lines', attributed_amount: '40.00', invoice_date: '2026-06-15', counts_as_billed: true })]);
    expect(partial.bills[0]!.invoice_number).toMatch(/^P52-/);
    expect(find(out, w.po.twoA!)).toMatchObject({ days_since_last_bill: null, last_bill_date: null, bills: [], bills_total: 0 });
  });

  it('a bill that no longer counts (cancelled) is listed but not billed; days since last bill ignore it', async () => {
    const po = await mkPo(pool, w.f, { month: '2026-06', lines: [{ acct: w.f.acc.opex, price: 500 }] });
    const bill = (await pool.query("INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount, created_by, status, purchase_order_id) VALUES (gen_random_uuid(), $1, 'CANC-1', $2, '2026-07-01', 500, 15, 75, 575, $3, 'cancelled', $4) RETURNING id", [w.f.co, w.f.supplier, w.f.owner, po.po])).rows[0].id as string;
    await pool.query("INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 500, 'mcp')", [w.f.co, po.po, bill]);
    const row = find(await report(), po);
    expect(row).toMatchObject({ billed: '0.00', outstanding: '500.00', days_since_last_bill: null, bills_total: 1 });
    expect(row.bills[0]).toMatchObject({ bill_id: bill, status: 'cancelled', counts_as_billed: false });
  });

  it('received is min(received, ordered) x unit price; the days since the last receipt come from the latest note', async () => {
    const row = find(await report(), recv);
    // line 0: 4 x 5 = 20; line 1: min(6, 4) x 25 = 100.
    expect([row.ordered, row.received, row.billed, row.outstanding]).toEqual(['150.00', '120.00', '0.00', '150.00']);
    expect(row.last_receipt_date).toBe('2026-06-10');
    expect(row.days_since_last_receipt).toBe(daysSince('2026-06-10'));
    expect(find(await report(), w.po.partial!)).toMatchObject({ received: '0.00', last_receipt_date: null, days_since_last_receipt: null });
  });

  it('a cancelled goods received note is not counted as received, nor as the last receipt', async (t) => {
    // ci-integration-skip: the schema of a branch cut before migration 1021 has no 'cancelled' note status; on master (1021) this runs.
    if (!hasCancelledStatus) t.skip();
    const row = find(await report(), cancelledGrnPo!);
    expect([row.received, row.last_receipt_date]).toEqual(['15.00', '2026-05-21']);
    expect(row.days_since_last_receipt).toBe(daysSince('2026-05-21'));
  });

  it('a note whose quantities were taken back (po line received 0) counts 0 even though its items remain', async () => {
    const po = await mkPo(pool, w.f, { month: '2026-05', status: 'approved', lines: [{ acct: w.f.acc.opex, qty: 2, price: 50, received: 0 }] });
    await mkGrn(pool, w.f, po, [[po.items[0]!, 2]], '2026-05-25', 'rejected');
    expect(find(await report(), po).received).toBe('0.00');
  });
});

describe('filters, order and paging', () => {
  it('oldest first, then PO number; every filter narrows the same rows', async () => {
    const all = await report();
    const order = all.items.map((i) => [i.order_date, i.po_number]);
    expect(order).toEqual([...order].sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0)));
    expect((await report({ status: 'cancelled' })).items.map((i) => i.id)).toEqual([w.po.cancelled!.po]);
    expect((await report({ status: ['cancelled', 'draft'] })).total).toBe(2);
    expect((await report({ supplier_id: w.sup2 })).items.map((i) => i.id)).toEqual([w.po.twoB!.po]);
    expect((await report({ from: '2026-07-01', to: '2026-12-31' })).items.map((i) => i.id)).toEqual([w.po.july!.po]);
    const old = await report({ older_than_days: daysSince('2026-06-02') });
    expect(old.items.every((i) => i.age_days > daysSince('2026-06-02'))).toBe(true);
    expect(old.items.map((i) => i.id)).toContain(recv.po);
    expect(old.items.map((i) => i.id)).not.toContain(w.po.partial!.po);
    const open = await report({ only_outstanding: true });
    expect(open.items.every((i) => cents(i.outstanding) > 0)).toBe(true);
    expect(open.total).toBe(open.items.length);
  });

  it('only_outstanding leaves out a fully billed PO', async () => {
    const po = await mkPo(pool, w.f, { month: '2026-06', lines: [{ acct: w.f.acc.opex, price: 60 }] });
    const bill = await pool.query("INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount, created_by, status, purchase_order_id) VALUES (gen_random_uuid(), $1, 'FULL-1', $2, '2026-06-20', 60, 15, 9, 69, $3, 'approved', $4) RETURNING id", [w.f.co, w.f.supplier, w.f.owner, po.po]);
    expect(bill.rowCount).toBe(1);
    expect(find(await report(), po)).toMatchObject({ billed: '60.00', outstanding: '0.00' });
    expect((await report({ only_outstanding: true })).items.map((i) => i.id)).not.toContain(po.po);
  });

  it('pages walk every PO once, in the same order, with the unpaged total beside them', async () => {
    const all = await report();
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page: Out = await report({ limit: 4, offset });
      expect(page.total).toBe(all.total);
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((i) => i.id));
      offset = page.next_offset;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(all.items.map((i) => i.id));
    const filtered = await report({ only_outstanding: true });
    const pagedOut: string[] = [];
    for (let o: number | null = 0; o !== null;) {
      const page: Out = await report({ only_outstanding: true, limit: 3, offset: o });
      pagedOut.push(...page.items.map((i) => i.id));
      o = page.next_offset;
    }
    expect(pagedOut).toEqual(filtered.items.map((i) => i.id));
  });
});

describe('refusals and tenancy', () => {
  it('a missing scope and malformed arguments are refused', async () => {
    expect((await mcp(pool, w.u, 'po_status_report', {}, { role: 'owner', scopes: ['read:reports'] })).isError).toBe(true);
    expect(text(await mcp(pool, w.u, 'po_status_report', { status: 'bogus' }, INV))).toMatch(/status must be/);
    expect(text(await mcp(pool, w.u, 'po_status_report', { supplier_id: 'nope' }, INV))).toMatch(/invalid supplier_id/);
    expect(text(await mcp(pool, w.u, 'po_status_report', { from: '2026-02-31' }, INV))).toMatch(/invalid from/);
    expect(text(await mcp(pool, w.u, 'po_status_report', { older_than_days: -1 }, INV))).toMatch(/older_than_days/);
    expect(text(await mcp(pool, w.u, 'po_status_report', { only_outstanding: 'yes' }, INV))).toMatch(/only_outstanding/);
  });

  it('another company\'s POs, bills and suppliers never appear, for a user in both companies', async () => {
    const mine = await report();
    const theirs = new Set([...Object.values(other.po)].map((p) => p.po));
    expect(mine.items.some((i) => theirs.has(i.id))).toBe(false);
    expect(JSON.stringify(mine)).not.toContain(other.f.supplier);
    expect(JSON.stringify(mine)).not.toContain(other.bills.partial);
    expect((await report({ supplier_id: other.f.supplier })).items).toEqual([]);
    const there = await report({}, { userId: w.f.owner, homeCompanyId: other.f.co, token: '' });
    expect(there.items.map((i) => i.id).sort()).toEqual([...theirs].sort());
    expect(there.items.some((i) => i.id === w.po.partial!.po)).toBe(false);
  });

  it('the money columns are exact decimal text, never a float', async () => {
    for (const i of (await report()).items) {
      for (const v of [i.ordered, i.received, i.billed, i.outstanding, i.committed]) expect(v).toMatch(/^-?\d+\.\d{2}$/);
      expect(money(cents(i.ordered) - cents(i.billed) < 0 ? 0 : cents(i.ordered) - cents(i.billed))).toBe(i.outstanding);
    }
  });
});

async function poCommittedByIds(pos: readonly SeededPo[]): Promise<Map<string, number>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { als } = await import('@/lib/als');
    return await als.run({ client, companyId: w.f.co, userId: w.f.owner, claims: {} } as never, () => poCommittedCents(w.f.co, pos.map((p) => p.po)));
  } finally { await client.query('ROLLBACK'); client.release(); }
}
