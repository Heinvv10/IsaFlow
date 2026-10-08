/**
 * A draft edit that replaces the lines keeps the CC1 / CC2 / BU they carry
 * (#663 follow-up): the customer invoice PUT and update_supplier_invoice both
 * deleted and re-inserted lines without them, so every save stripped them.
 *
 * A key sent wins (null clears); a key left out keeps the value every stored
 * line shares; when the stored lines differ on it the edit is refused with a
 * 400 / tool error and nothing moves. A resend that keeps the content keeps
 * the approval clearing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { updateSupplierInvoiceTool } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany, invoiceRoutes, plantInvoice } from './r035-pr4.helpers';
import { approvedFor, cleanupDims, digestOf, plantDims, type Dims } from './dims-approval.helpers';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const routes = invoiceRoutes(tokens);
let owner = '';
let other = '';
let fx: Fixture;

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
  fx = await seedFixture('DIMS', process.env.DATABASE_URL!);
}, 120000);
afterAll(async () => {
  await cleanupDims(pool, [...companies, fx.companyId]);
  await dropFixture(fx);
  await cleanupPr4(pool, companies, [owner, other]);
}, 120000);

type Row = { description: string; cc1_id: string | null; cc2_id: string | null; bu_id: string | null };
const RESEND = [{ description: 'Line A', quantity: 2, unitPrice: 300 }, { description: 'Line B', quantity: 1, unitPrice: 400 }];

async function invoiceLines(id: string): Promise<Row[]> {
  return (await pool.query(
    'SELECT description, cc1_id, cc2_id, bu_id FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY description', [id])).rows;
}

type Key = keyof Dims | null;
/** A draft invoice whose two lines carry `a` and `b` as (cc1, cc2, bu), named by fixture key. */
async function taggedInvoice(a: Key[], b: Key[]) {
  const c = await invoiceCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
  const d = await plantDims(pool, c);
  // functional_total as the edit recomputes it, so a resend moves nothing but what it sends.
  const inv = await plantInvoice(pool, c, owner, { functionalTotal: 1150 });
  for (const [desc, keys] of [['Line A', a], ['Line B', b]] as const) {
    await pool.query('UPDATE customer_invoice_items SET cc1_id = $3, cc2_id = $4, bu_id = $5 WHERE invoice_id = $1 AND description = $2',
      [inv.id, desc, ...keys.map((k) => (k ? d[k] : null))]);
  }
  return { c, d, inv };
}

describe('the customer invoice draft PUT', () => {
  it('a resend that leaves dimensions out keeps the ones every line shares, and the approval still clears', async () => {
    const { c, d, inv } = await taggedInvoice(['fno1', 'proj1', 'bu1'], ['fno1', 'proj1', 'bu1']);
    const before = await digestOf(pool, c, 'customer_invoice', inv.id);
    await approvedFor(pool, c, 'customer_invoice', inv.id, other, owner);
    const res = await routes.edit(owner, c, { id: inv.id, items: RESEND });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    for (const l of await invoiceLines(inv.id)) expect([l.cc1_id, l.cc2_id, l.bu_id]).toEqual([d.fno1, d.proj1, d.bu1]);
    expect(await digestOf(pool, c, 'customer_invoice', inv.id)).toBe(before);
    await pool.query("UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [inv.id]);
  });

  it('a dimension sent wins and null clears it; a retag stales the approval', async () => {
    const { c, d, inv } = await taggedInvoice(['fno1', 'proj1', 'bu1'], ['fno1', 'proj1', 'bu1']);
    await approvedFor(pool, c, 'customer_invoice', inv.id, other, owner);
    const res = await routes.edit(owner, c, { id: inv.id, items: [
      { ...RESEND[0], cc2Id: d.proj2 }, { ...RESEND[1], cc1Id: null, cc2Id: null, buId: d.bu2 }] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    // Line A: CC1 derived from the new project, BU kept. Line B: cleared but for the BU sent.
    expect((await invoiceLines(inv.id)).map((l) => [l.cc1_id, l.cc2_id, l.bu_id]))
      .toEqual([[d.fno2, d.proj2, d.bu1], [null, null, d.bu2]]);
    await expect(pool.query("UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [inv.id]))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('refuses a resend that leaves out a dimension the lines differ on, and changes nothing', async () => {
    const { c, inv } = await taggedInvoice(['fno1', 'proj1', 'bu1'], ['fno2', 'proj2', 'bu1']);
    const before = await invoiceLines(inv.id);
    const res = await routes.edit(owner, c, { id: inv.id, notes: 'moved', items: RESEND });
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/different CC2 \(project\) values.*cc2Id/);
    expect(await invoiceLines(inv.id)).toEqual(before);
    expect((await pool.query('SELECT notes FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].notes).toBeNull();
  });

  it('round-trips: the GET returns each line\'s dimensions and a PUT sending them back keeps them', async () => {
    const { c, inv } = await taggedInvoice(['fno1', 'proj1', 'bu1'], ['fno2', 'proj2', null]);
    const before = await invoiceLines(inv.id);
    const got = await routes.get(owner, c, inv.id);
    const items = (got.state.body as { data: { items: Row[] } }).data.items;
    const sent = items.map((it) => ({ ...RESEND.find((r) => r.description === it.description)!,
      cc1Id: it.cc1_id, cc2Id: it.cc2_id, buId: it.bu_id }));
    const res = await routes.edit(owner, c, { id: inv.id, items: sent });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await invoiceLines(inv.id)).toEqual(before);
  });

  it('refuses, as create does, a project under another FNO than the customer\'s', async () => {
    const { c, d, inv } = await taggedInvoice([null, null, null], [null, null, null]);
    await pool.query('UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [inv.customerId, d.fno1]);
    const res = await routes.edit(owner, c, { id: inv.id, items: [{ ...RESEND[0], cc2Id: d.proj2 }, RESEND[1]] });
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/differs from the customer's FNO/);
  });

  it('refuses, as create does, a dimension of another company, and changes nothing', async () => {
    const { c, inv } = await taggedInvoice([null, null, null], [null, null, null]);
    const foreign = await taggedInvoice([null, null, null], [null, null, null]);
    const res = await routes.edit(owner, c, { id: inv.id, items: [{ ...RESEND[0], cc2Id: foreign.d.proj1 }, RESEND[1]] });
    expect(res.state.statusCode).toBe(400);
    expect((await invoiceLines(inv.id)).every((l) => l.cc2_id === null)).toBe(true);
  });

  it('refuses a customer change, lines untouched, onto a customer whose FNO the stored lines contradict', async () => {
    const { c, d, inv } = await taggedInvoice(['fno1', 'proj1', null], [null, null, null]);
    const moved = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id,company_id,name,default_cc1_id) VALUES($1,$2,$3,$4)', [moved, c, 'dims F2', d.fno2]);
    const res = await routes.edit(owner, c, { id: inv.id, clientId: moved });
    expect(res.state.statusCode).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/differs from the customer's FNO/);
    expect((await pool.query('SELECT customer_id FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].customer_id).toBe(inv.customerId);
  });
});

const ctx = (): McpToolContext => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti-dims' }) as unknown as McpToolContext;
let seq = 0;
const update = (id: string, args: Record<string, unknown>) =>
  inTx(fx, () => updateSupplierInvoiceTool.handler({ invoice_id: id, ...args, idempotency_key: `dims-${++seq}` }, ctx()));
const billLines = async (id: string) => (await sql`
  SELECT description, quantity::FLOAT8 AS quantity, cc1_id, cc2_id, bu_id FROM supplier_invoice_items
  WHERE supplier_invoice_id = ${id}::UUID ORDER BY description`) as (Row & { quantity: number })[];

async function taggedBill(b: Dims, second: 'same' | 'other') {
  const bill = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: fx.supplierId, invoiceNumber: `DIMS-${++seq}-${fx.tag}`.slice(0, 50), invoiceDate: '2026-05-01',
    items: [{ description: 'Cable', quantity: 1, unitPrice: 100, cc2Id: b.proj1, buId: b.bu1 },
      { description: 'Labour', quantity: 2, unitPrice: 50, cc2Id: second === 'same' ? b.proj1 : b.proj2, buId: b.bu1 }],
  }, fx.userId));
  return bill.id;
}
const LINES = [{ description: 'Cable', quantity: 3, unit_price: 100 }, { description: 'Labour', quantity: 2, unit_price: 50 }];

describe('update_supplier_invoice', () => {
  let dims: Dims;
  beforeAll(async () => { dims = await plantDims(pool, fx.companyId); });

  it('a line replacement that leaves dimensions out keeps the ones every line shares', async () => {
    const id = await taggedBill(dims, 'same');
    const r = await update(id, { lines: LINES });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const lines = await billLines(id);
    expect(lines.map((l) => l.quantity)).toEqual([3, 2]);
    for (const l of lines) expect([l.cc1_id, l.cc2_id, l.bu_id]).toEqual([dims.fno1, dims.proj1, dims.bu1]);
  });

  it('a dimension named on a line wins for that line; the rest are kept', async () => {
    const id = await taggedBill(dims, 'same');
    const r = await update(id, { lines: [{ ...LINES[0], bu: dims.bu2 }, LINES[1]] });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect((await billLines(id)).map((l) => [l.cc1_id, l.cc2_id, l.bu_id]))
      .toEqual([[dims.fno1, dims.proj1, dims.bu2], [dims.fno1, dims.proj1, dims.bu1]]);
  });

  it('refuses a replacement that leaves out a dimension the lines differ on, and changes nothing', async () => {
    const id = await taggedBill(dims, 'other');
    const before = await billLines(id);
    const r = await update(id, { lines: LINES });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/different CC2 \(project\) values/);
    expect(await billLines(id)).toEqual(before);
  });
});
