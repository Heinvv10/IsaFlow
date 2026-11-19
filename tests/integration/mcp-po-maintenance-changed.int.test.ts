/**
 * update_purchase_order: the status read before the budget gate and the status under the row lock (review M4;
 * docs/design/mcp-po-maintenance.md, the census). A draft approved between the two would need the gate AFTER the PO row, which
 * inverts the lock order, so the update refuses it as PURCHASE_ORDER_CHANGED (409, retry). The window is opened deterministically:
 * the other connection flips the status straight after the update's first status read. Real PostgreSQL, as app_user.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hooks = vi.hoisted(() => ({ afterStatusRead: null as null | (() => Promise<void>), fired: 0 }));
// Every statement passes through untouched (the wrapper must stay lazy); the first plain status read of purchase_orders runs the hook once.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => unknown;
  const wrapper = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const hook = hooks.afterStatusRead;
    if (hook && /^\s*SELECT status FROM purchase_orders WHERE id/.test(text)) {
      hooks.afterStatusRead = null;
      return (async () => { const rows = await realSql(strings, ...values); hooks.fired++; await hook(); return rows; })();
    }
    return realSql(strings, ...values);
  };
  return { ...real, sql: Object.assign(wrapper, realSql) };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo } from './helpers/poBillLinkHarness';
import { auditOf, budgetEvents, callTool, dropMaintExtras, poLines, poRow } from './helpers/poMaintHarness';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-maint-changed'); await setPolicy(pool, f, 'block'); }, 60_000);
afterAll(async () => { try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const line = { description: 'Replaced', quantity: 1, unit_price: 5000, tax_rate: 0, gl_account_id: '' };

describe.each([['draft', 'approved'], ['approved', 'cancelled'], ['submitted', 'approved']])('a %s PO that becomes %s between the status read and the row lock', (before, after) => {
  it('is PURCHASE_ORDER_CHANGED: nothing written, no budget event, no audit row', async () => {
    const po = await seedPo(pool, f, { status: before, lines: [100], acct: f.acc.opex, cc1: f.cc.FT });
    hooks.fired = 0;
    hooks.afterStatusRead = async () => { await pool.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [po.po, after]); };
    const r = await callTool(pool, f, update, { po_id: po.po, notes: 'raced', lines: [{ ...line, gl_account_id: f.acc.opex }] });
    expect(hooks.fired, 'the window was opened').toBe(1);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('The purchase order changed while it was being saved — reload it and try again.');
    expect(await poRow(pool, po.po)).toMatchObject({ status: after, notes: null, subtotal: '100.00' });
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['100.00']);
    expect(await budgetEvents(pool, po.po)).toEqual([]);
    expect(await auditOf(pool, f, po.po)).toEqual([]);
  });
});
