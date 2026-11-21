/**
 * PR #1703, ledger breaker round 9 (ported from its zz-b9-attack repros at 9b6c233bb5), real PostgreSQL 16. The corrected rule:
 * per (bill, PO) each PO line's postings are netted first; the bill bills max(0, sum of the line nets), each positive line keeping
 * its net less a largest-remainder share of the negatives (budgets/lineNetSpread). Fixture route: isaflow_schema_fixture.
 * B9-1 a line's own credit stays on that line: a fully billed PO commits 0.
 * B9-2 committed stays on the right PO line (account), and so does the block decision.
 * B9-3 largest remainder: no cent drifts onto a line that did not post it.
 * B9-4 two POs on one bill, negatives on one, header residual on a third: consistency of billTies / lines / 1022 twin.
 * B9-5 randomised: sum of spread shares per (bill, PO) == billTies lines cents, never above sum of positive postings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { readCommitments, billedLinesByPoItem } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { billTies } from '@/modules/accounting/services/budgets/billAttribution';
import { poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';
import { readPurchaseOrderDetail } from '@/modules/accounting/services/ap/purchaseOrderDetailService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'brk-r9'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const lines = async (po: SeededPo, accts: string[] = [f.acc.opex]) => {
  const rows = await readCommitments(f.co, accts, '2026-06-01', '2026-06-30', {});
  return po.items.map((id) => { const r = rows.find((x) => x.poItemId === id); return r ? openPoLineCents(r.lineTotal, r.billed) : 0; });
};
const svc = async (po: SeededPo) => (await poCommittedCents(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const detail = async (po: SeededPo) => {
  const d = await readPurchaseOrderDetail(f.co, { poId: po.po, poNumber: null });
  const dp = d as unknown as { purchase_order: Record<string, unknown>; lines: Array<Record<string, unknown>> } & Record<string, unknown>;
  const s = (dp.summary ?? dp) as Record<string, unknown>;
  return {
    lines: dp.lines.map((l) => ({ total: l.line_total, billed: l.amount_billed, out: l.outstanding_amount_to_bill })),
    billed_total: s.billed_total ?? dp.billed_total, outstanding: s.outstanding_to_bill ?? dp.outstanding_to_bill, fully: s.fully_billed ?? dp.fully_billed,
  };
};
const perItem = async (po: SeededPo) => {
  const m = await billedLinesByPoItem(f.co, po.items.map((i) => i.toLowerCase()), []);
  return po.items.map((i) => Math.round((m.get(i.toLowerCase()) ?? []).reduce((s, p) => s + p.amount * 100, 0)));
};

describe('B9-1 a line\'s credit stays on that line: a fully billed PO commits 0', () => {
  it('open PO A R100 / B R1000; one approved bill: A +1000, A -900 (corrected qty), B +1000; subtotal 1100. Raw per line A 100 / B 1000: committed must be 0', async () => {
    const po = await seedPo(pool, f, { lines: [100, 1000] });
    await seedRawBill(pool, f, { items: [{ total: 1000, poItem: po.items[0] }, { total: -900, poItem: po.items[0] }, { total: 1000, poItem: po.items[1] }], subtotal: 1100, total: 1265 });
    const out = { billed: await billed(po), perItem: await perItem(po), lines: await lines(po), svc: await svc(po), detail: await detail(po) };
    expect({ billed: out.billed, lines: out.lines, svc: out.svc }).toEqual({ billed: 110000, lines: [0, 0], svc: 0 });
    expect(out.perItem).toEqual([10000, 100000]); // line A billed its own net, R100
  });
  it('variant without any line over its total in aggregate: A R100: +150, -50; B R1000: +1000. committed must be 0', async () => {
    const po = await seedPo(pool, f, { lines: [100, 1000] });
    await seedRawBill(pool, f, { items: [{ total: 150, poItem: po.items[0] }, { total: -50, poItem: po.items[0] }, { total: 1000, poItem: po.items[1] }], subtotal: 1100, total: 1265 });
    const out = { billed: await billed(po), perItem: await perItem(po), lines: await lines(po), svc: await svc(po), detail: await detail(po) };
    expect({ billed: out.billed, lines: out.lines, svc: out.svc }).toEqual({ billed: 110000, lines: [0, 0], svc: 0 });
  });
});

describe('B9-2 committed stays on the PO line (account) that posted it', () => {
  it('PO A R500 opex/FT, B R500 travel; bill: A +500, B +500, B -450 (credit on B). Raw: A open 0, B open 450', async () => {
    const po = await seedPo(pool, f, { lines: [500, 500], cc1: f.cc.FT });
    await pool.query('UPDATE po_items SET gl_account_id = $1, cc1_id = NULL WHERE id = $2', [f.acc.travel, po.items[1]]);
    await seedRawBill(pool, f, { items: [{ total: 500, poItem: po.items[0] }, { total: 500, poItem: po.items[1] }, { total: -450, poItem: po.items[1] }], subtotal: 550, total: 632.5 });
    const out = { billed: await billed(po), perItem: await perItem(po), lines: await lines(po, [f.acc.opex, f.acc.travel]), svc: await svc(po), detail: await detail(po) };
    expect(out.lines).toEqual([0, 45000]);
  });
  it('block: opex/FT budget R1000 June; the same PO + bill; approve an R900 opex/FT bill', async () => {
    await setPolicy(pool, f, 'block');
    try {
      const po = await seedPo(pool, f, { lines: [500, 500], cc1: f.cc.FT });
      await pool.query('UPDATE po_items SET gl_account_id = $1, cc1_id = NULL WHERE id = $2', [f.acc.travel, po.items[1]]);
      await seedRawBill(pool, f, { items: [{ total: 500, poItem: po.items[0] }, { total: 500, poItem: po.items[1] }, { total: -450, poItem: po.items[1] }], subtotal: 550, total: 632.5 });
      const key = { glAccountId: f.acc.opex, cc1Id: f.cc.FT, cc2Id: null, buId: null, month: '2026-06' };
      const r = (await remainingFor(f.co, [key]))[0]!;
      const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 900, cc1: f.cc.FT }], { date: '2026-06-20' });
      const req = await openRequest(pool, f, f.owner);
      const ui = { channel: 'ui' as const, lock: 'take' as const, reason: 'b9', actorRole: 'owner' };
      const res = await req.run(() => approveSupplierInvoice(f.co, bill, f.owner, { budget: ui })).then(() => 'approved', (e: unknown) => (e instanceof BudgetExceededError ? 'refused' : String(e)));
      await req.rollback();
      expect(r.committed).toBe(0);
      expect(res).toBe('approved');
    } finally { await setPolicy(pool, f, 'warn'); }
  });
});

describe('B9-1c block decision on the cap loss', () => {
  it('opex/FT R1000 June; PO A R100 / B R1000 opex/FT; bill A +1000, A -900, B +1000 (fully billed); approve an R700 opex/FT bill under block', async () => {
    await setPolicy(pool, f, 'block');
    try {
      // Other fixtures in this file also commit opex/FT June: measure the delta this PO adds.
      const key = { glAccountId: f.acc.opex, cc1Id: f.cc.FT, cc2Id: null, buId: null, month: '2026-06' };
      const before = (await remainingFor(f.co, [key]))[0]!;
      const po = await seedPo(pool, f, { lines: [100, 1000], cc1: f.cc.FT });
      await seedRawBill(pool, f, { items: [{ total: 1000, poItem: po.items[0] }, { total: -900, poItem: po.items[0] }, { total: 1000, poItem: po.items[1] }], subtotal: 1100, total: 1265 });
      const r = (await remainingFor(f.co, [key]))[0]!;
      expect(r.committed - before.committed).toBe(0);
    } finally { await setPolicy(pool, f, 'warn'); }
  });
});

describe('B9-2c the credited line commits its own remainder, so its budget refuses', () => {
  it('travel budget R500 June (company grain); PO A R500 opex/FT, B R500 travel; bill A +500, B +500, B -450; approve an R200 travel bill under block', async () => {
    await setPolicy(pool, f, 'block');
    try {
      const key = { glAccountId: f.acc.travel, cc1Id: null, cc2Id: null, buId: null, month: '2026-06' };
      const before = (await remainingFor(f.co, [key]))[0]!;
      const po = await seedPo(pool, f, { lines: [500, 500], cc1: f.cc.FT });
      await pool.query('UPDATE po_items SET gl_account_id = $1, cc1_id = NULL WHERE id = $2', [f.acc.travel, po.items[1]]);
      await seedRawBill(pool, f, { items: [{ total: 500, poItem: po.items[0] }, { total: 500, poItem: po.items[1] }, { total: -450, poItem: po.items[1] }], subtotal: 550, total: 632.5 });
      const r = (await remainingFor(f.co, [key]))[0]!;
      const bill = await makeBill(pool, f, [{ acct: f.acc.travel, amount: 200, cc1: null }], { date: '2026-06-20' });
      const req = await openRequest(pool, f, f.owner);
      const ui = { channel: 'ui' as const, lock: 'take' as const, reason: 'b9', actorRole: 'owner' };
      const res = await req.run(() => approveSupplierInvoice(f.co, bill, f.owner, { budget: ui })).then(() => 'approved', (e: unknown) => (e instanceof BudgetExceededError ? 'refused' : String(e)));
      await req.rollback();
      expect(r.committed - before.committed).toBe(450);
      expect(res).toBe('refused');
    } finally { await setPolicy(pool, f, 'warn'); }
  });
});

describe('B9-6 the header room reads the line amounts', () => {
  it('PO A R100 / B R1000; bill X lines A +1000, A -900, B +500 (raw A 100, B 500); header bill H R500 links the PO: fully billed, committed must be 0', async () => {
    const po = await seedPo(pool, f, { lines: [100, 1000] });
    await seedRawBill(pool, f, { items: [{ total: 1000, poItem: po.items[0] }, { total: -900, poItem: po.items[0] }, { total: 500, poItem: po.items[1] }], subtotal: 600, total: 690 });
    await seedRawBill(pool, f, { items: [{ total: 500 }], subtotal: 500, total: 575, header: po.po });
    const out = { billed: await billed(po), perItem: await perItem(po), lines: await lines(po), svc: await svc(po), detail: await detail(po) };
    expect({ billed: out.billed, lines: out.lines, svc: out.svc }).toEqual({ billed: 110000, lines: [0, 0], svc: 0 });
  });
});

describe('B9-3 largest remainder, no cent drift', () => {
  it('PO L1 R0.01, L2 R0.01, L3 R0.01; bill +0.01 on each, -0.01 on L1: raw L1 0, L2 0.01, L3 0.01 -> committed 1c', async () => {
    const po = await seedPo(pool, f, { lines: [0.01, 0.01, 0.01] });
    await seedRawBill(pool, f, { items: [{ total: 0.01, poItem: po.items[0] }, { total: 0.01, poItem: po.items[1] }, { total: 0.01, poItem: po.items[2] }, { total: -0.01, poItem: po.items[0] }], subtotal: 0.02, total: 0.02 });
    const out = { billed: await billed(po), perItem: await perItem(po), lines: await lines(po), svc: await svc(po) };
    expect(out.lines.reduce((s, c) => s + c, 0)).toBe(1);
  });
  it('realistic: PO A R333.33 B R333.33 C R10.00; bill +333.33 A, +333.33 B, +10.00 C, -0.02 on A (rounding credit)', async () => {
    const po = await seedPo(pool, f, { lines: [333.33, 333.33, 10] });
    await seedRawBill(pool, f, { items: [{ total: 333.33, poItem: po.items[0] }, { total: 333.33, poItem: po.items[1] }, { total: 10, poItem: po.items[2] }, { total: -0.02, poItem: po.items[0] }], subtotal: 676.64, total: 778.14 });
    const out = { billed: await billed(po), perItem: await perItem(po), lines: await lines(po), svc: await svc(po) };
    expect(out.lines.reduce((s, c) => s + c, 0)).toBe(2);
  });
});

describe('B9-4 two POs on one bill, negatives on one, header on a third', () => {
  it('P1 A500/B500, P2 A400, P3 header R300; bill lines +600 P1.A, -700 P1.B, +400 P2.A; subtotal 300, header P3', async () => {
    const p1 = await seedPo(pool, f, { lines: [500, 500] });
    const p2 = await seedPo(pool, f, { lines: [400] });
    const p3 = await seedPo(pool, f, { lines: [300] });
    const x = await seedRawBill(pool, f, { items: [{ total: 600, poItem: p1.items[0] }, { total: -700, poItem: p1.items[1] }, { total: 400, poItem: p2.items[0] }], subtotal: 300, total: 345, header: p3.po });
    const ties = (await billTies(f.co, [p1.po, p2.po, p3.po], { statuses: ['approved'] })).filter((t) => t.billId === x.id.toLowerCase()).map((t) => [t.via, t.cents]);
    const out = { ties, billed: [await billed(p1), await billed(p2), await billed(p3)], p1: await lines(p1), p2: await lines(p2), p3: await lines(p3),
      per: [await perItem(p1), await perItem(p2)] };
    expect(out.billed).toEqual([0, 40000, 0]);
    expect(out.p1).toEqual([50000, 50000]);
    expect(out.p2).toEqual([0]);
    expect(out.p3).toEqual([30000]);
  });
});

describe('B9-5 randomised conservation', () => {
  it('60 random bills on a 4-line PO: shares sum to billTies lines cents within the lines\' limits; per line never above min(net, total)', async () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const bad: unknown[] = [];
    for (let k = 0; k < 60; k++) {
      const po = await seedPo(pool, f, { lines: [100, 250.5, 33.33, 1000] });
      const n = 2 + Math.floor(rnd() * 6);
      const items = Array.from({ length: n }, () => ({ total: Math.round((rnd() * 600 - 200) * 100) / 100 || 0.01, poItem: po.items[Math.floor(rnd() * 4)] }));
      const sub = Math.max(0, Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100);
      const x = await seedRawBill(pool, f, { items, subtotal: sub, total: sub });
      const tie = (await billTies(f.co, [po.po], { statuses: ['approved'] })).find((t) => t.billId === x.id.toLowerCase());
      const per = await perItem(po);
      const sum = per.reduce((s, c) => s + c, 0);
      // Each line against its own net, max(0, net of the bill's postings to it) (review r10 LOW-2), and its line total (breaker r10:
      // a line is never billed above its total, the excess water-filled elsewhere, what no line can take netted nowhere).
      const caps = [10000, 25050, 3333, 100000];
      const netPer = po.items.map((it, j) => Math.min(caps[j]!, Math.max(0, items.filter((i) => i.poItem === it).reduce((s, i) => s + Math.round(i.total * 100), 0))));
      const want = Math.min(tie?.cents ?? 0, netPer.reduce((s, c) => s + c, 0));
      const over = per.some((c, i) => c > netPer[i]!);
      if (sum !== want || over || per.some((c) => c < 0)) bad.push({ items, per, sum, tie: tie?.cents, netPer });
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
