/**
 * PR #1703, ledger breaker round 10 (ported from its zz-b10 repros at 932527a5ec), real PostgreSQL 16: line nets first, then a
 * largest-remainder share of the negatives, each line capped at min(its net, its line_total), the excess water-filled onto lines
 * with room (budgets/lineNetSpread). Fixture route: isaflow_schema_fixture.
 * R10-F  randomised, every reader against an independent reference of the rule (+ header water-fill invariants).
 * R10-1  an over-billed line never swallows a sibling's credit: its share is capped and the excess goes to a line with room.
 * R10-2  PO isolation: a credit on PO2 never touches PO1 on the same bill.
 * R10-3  the tie cent: which account carries it follows the bill's line order; subset reads agree.
 * R10-4  header room after the spread: a header bill fills the credited line's room first by share.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';
import { seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { readCommitments, billedLinesByPoItem } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';
import { readPurchaseOrderDetail } from '@/modules/accounting/services/ap/purchaseOrderDetailService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'brk-r10'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const committedLines = async (po: SeededPo, accts: string[]) => {
  const rows = await readCommitments(f.co, accts, '2026-06-01', '2026-06-30', {});
  return po.items.map((id) => { const r = rows.find((x) => x.poItemId === id); return r ? openPoLineCents(r.lineTotal, r.billed) : null; });
};
const svc = async (po: SeededPo) => (await poCommittedCents(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const perItem = async (po: SeededPo, ids: string[] = po.items) => {
  const m = await billedLinesByPoItem(f.co, ids.map((i) => i.toLowerCase()), []);
  return ids.map((i) => Math.round((m.get(i.toLowerCase()) ?? []).reduce((s, p) => s + p.amount * 100, 0)));
};
const detail = async (po: SeededPo) => {
  const d = await readPurchaseOrderDetail(f.co, { poId: po.po, poNumber: null }) as unknown as Record<string, unknown> & { lines: Array<Record<string, unknown>> };
  return { amountBilled: d.lines.map((l) => Math.round(Number(l.amount_billed) * 100)), billedTotal: Math.round(Number(d.billed_total) * 100), fully: d.fully_billed };
};
const cents = (r: number) => Math.round(r * 100);
const mkPo = async (lines: number[], accts: string[]) => {
  const po = await seedPo(pool, f, { lines });
  for (const [i, a] of accts.entries()) await pool.query('UPDATE po_items SET gl_account_id = $1 WHERE id = $2', [a, po.items[i]]);
  return po;
};
const bill = async (items: Array<{ total: number; poItem?: string | null }>, header: string | null = null) => {
  const sub = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
  return seedRawBill(pool, f, { items, subtotal: sub, total: Math.round(sub * 115) / 100, header });
};

/** The rule, written independently: exact rationals, largest remainder, ties to the line that appears first in the bill. */
function refSpread(nets: number[], caps: number[]): number[] {
  const lim = nets.map((c, i) => Math.min(Math.max(0, c), caps[i]!));
  let left = Math.min(Math.max(0, nets.reduce((s, c) => s + c, 0)), lim.reduce((s, c) => s + c, 0));
  const out = nets.map(() => 0);
  while (left > 0) {
    const w = nets.map((c, i) => (out[i]! < lim[i]! ? Math.max(0, c) : 0));
    if (w.every((x) => x === 0)) break;
    const sh = refRound(left, w);
    sh.forEach((c, i) => { const t = Math.min(c, lim[i]! - out[i]!); out[i]! += t; left -= t; });
  }
  return out;
}
function refRound(amount: number, nets: number[]): number[] {
  const billedC = amount;
  const pos = nets.map((c) => Math.max(0, c));
  const P = pos.reduce((s, c) => s + c, 0);
  if (billedC === 0 || P === 0) return nets.map(() => 0);
  const fl = pos.map((c) => Math.floor((billedC * c) / P));
  const rem = pos.map((c, i) => billedC * c - fl[i]! * P);
  let left = billedC - fl.reduce((s, c) => s + c, 0);
  const order = pos.map((_, i) => i).filter((i) => pos[i]! > 0).sort((a, b) => rem[b]! - rem[a]! || a - b);
  for (const i of order) { if (left <= 0) break; fl[i]! += 1; left -= 1; }
  return fl;
}

describe('R10-F randomised: every reader against the rule', () => {
  it('60 POs (4 lines, 2 accounts), 1-3 line bills with credits, 0-2 header bills', async () => {
    let seed = 99991;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const totals = [100, 250.5, 33.33, 1000];
    const accts = [f.acc.opex, f.acc.travel, f.acc.opex, f.acc.travel];
    const bad: unknown[] = [];
    for (let k = 0; k < 60; k++) {
      const po = await mkPo(totals, accts);
      const lineBilled = [0, 0, 0, 0];
      let poBilled = 0;
      const nb = 1 + Math.floor(rnd() * 3);
      const log: unknown[] = [];
      for (let b = 0; b < nb; b++) {
        const n = 2 + Math.floor(rnd() * 5);
        const items = Array.from({ length: n }, () => ({ total: (Math.round((rnd() * 700 - 250) * 100) / 100) || 0.01, poItem: po.items[Math.floor(rnd() * 4)]! }));
        const raw = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
        await bill(raw < 0 ? [...items, { total: Math.round((-raw + rnd() * 50 + 0.01) * 100) / 100, poItem: null as unknown as string }] : items);
        // nets per PO line, in first-appearance order
        const seen: number[] = []; const net = new Map<number, number>();
        for (const it of items) { const i = po.items.indexOf(it.poItem); if (!net.has(i)) seen.push(i); net.set(i, (net.get(i) ?? 0) + cents(it.total)); }
        const sh = refSpread(seen.map((i) => net.get(i)!), seen.map((i) => cents(totals[i]!)));
        seen.forEach((i, j) => { lineBilled[i]! += sh[j]!; });
        poBilled += Math.max(0, [...net.values()].reduce((s, c) => s + c, 0));
        log.push(items.map((i) => [po.items.indexOf(i.poItem), i.total]));
      }
      const nh = Math.floor(rnd() * 3);
      let header = 0;
      for (let h = 0; h < nh; h++) { const amt = Math.round(rnd() * 800 * 100) / 100 || 1; header += cents(amt); await bill([{ total: amt }], po.po); }
      const tc = totals.map(cents);
      const open = tc.map((t, i) => Math.max(0, t - lineBilled[i]!));
      const expectSum = open.reduce((s, c) => s + c, 0) - Math.min(header, open.reduce((s, c) => s + c, 0));
      const basis = tc.reduce((s, c) => s + c, 0);
      const expBilled = poBilled + header;
      const got = {
        per: await perItem(po), perB: (await perItem(po, [po.items[1]!]))[0], c2: await committedLines(po, [f.acc.opex, f.acc.travel]),
        cOpex: await committedLines(po, [f.acc.opex]), svc: await svc(po), billed: await billed(po), det: await detail(po),
      };
      const sum = (got.c2 as number[]).reduce((s, c) => s + c, 0);
      const problems: string[] = [];
      if (JSON.stringify(got.per) !== JSON.stringify(lineBilled)) problems.push('perItem != rule');
      if (got.perB !== lineBilled[1]) problems.push('subset perItem differs');
      if (JSON.stringify(got.det.amountBilled) !== JSON.stringify(lineBilled)) problems.push('amount_billed != rule');
      if (sum !== expectSum) problems.push(`committed sum ${sum} != ${expectSum}`);
      if (got.svc !== sum) problems.push('svc != readCommitments');
      if (got.c2.some((c, i) => c === null || c < 0 || c > tc[i]!)) problems.push('line outside [0,total]');
      if (got.cOpex[0] !== got.c2[0] || got.cOpex[2] !== got.c2[2]) problems.push('opex-only read differs');
      if (got.billed !== expBilled) problems.push(`billed ${got.billed} != ${expBilled}`);
      if (got.det.billedTotal !== expBilled) problems.push('billed_total != billed');
      if (got.det.fully !== (basis > 0 && expBilled >= basis - 1)) problems.push('fully_billed');
      if (problems.length) bad.push({ k, problems, log, header, lineBilled, got });
    }
    expect(bad).toEqual([]);
  }, 300_000);
});

describe('R10-1 an over-billed line never swallows a sibling\'s credit', () => {
  it('A R100 opex +1000; B R1000 travel +1000; C R100 opex -900: billed 1100 of 1200', async () => {
    const po = await mkPo([100, 1000, 100], [f.acc.opex, f.acc.travel, f.acc.opex]);
    await bill([{ total: 1000, poItem: po.items[0] }, { total: 1000, poItem: po.items[1] }, { total: -900, poItem: po.items[2] }]);
    const out = { billed: await billed(po), per: await perItem(po), lines: await committedLines(po, [f.acc.opex, f.acc.travel]), svc: await svc(po), det: await detail(po) };
    expect([out.per, out.lines, out.svc]).toEqual([[10000, 100000, 0], [0, 0, 10000], 10000]);
  });
});

describe('R10-2 PO isolation on one bill', () => {
  it('PO1 [500], PO2 [500]; bill: PO1 +500, PO2 -300, unnamed +300', async () => {
    const p1 = await mkPo([500], [f.acc.opex]);
    const p2 = await mkPo([500], [f.acc.travel]);
    await bill([{ total: 500, poItem: p1.items[0] }, { total: -300, poItem: p2.items[0] }, { total: 300 }]);
    const out = { p1: await committedLines(p1, [f.acc.opex]), p2: await committedLines(p2, [f.acc.travel]), b: [await billed(p1), await billed(p2)] };
    expect(out).toEqual({ p1: [0], p2: [50000], b: [50000, 0] });
  });
});

describe('R10-3 the tie cent', () => {
  for (const order of ['A first', 'B first'] as const) {
    it(`A R1 opex, B R1 travel, C R1 opex; bill +0.01 A, +0.01 B, -0.01 C (${order})`, async () => {
      const po = await mkPo([1, 1, 1], [f.acc.opex, f.acc.travel, f.acc.opex]);
      const a = { total: 0.01, poItem: po.items[0] }; const b = { total: 0.01, poItem: po.items[1] }; const c = { total: -0.01, poItem: po.items[2] };
      await bill(order === 'A first' ? [a, b, c] : [b, a, c]);
      const out = { per: await perItem(po), perOnlyB: await perItem(po, [po.items[1]!]), both: await committedLines(po, [f.acc.opex, f.acc.travel]),
        travelOnly: await committedLines(po, [f.acc.travel]), svc: await svc(po) };
      expect(out.per.reduce((s, x) => s + x, 0)).toBe(1);
      expect(out.travelOnly[1]).toBe(out.both[1]);
    });
  }
});

describe('R10-4 header room after the spread', () => {
  it('A R500 opex, B R500 travel; bill X +500 A, +500 B, -500 B... with C R500 opex -500: header H R500', async () => {
    const po = await mkPo([500, 500, 500], [f.acc.opex, f.acc.travel, f.acc.opex]);
    await bill([{ total: 500, poItem: po.items[0] }, { total: 500, poItem: po.items[1] }, { total: -500, poItem: po.items[2] }]);
    const before = await committedLines(po, [f.acc.opex, f.acc.travel]);
    await bill([{ total: 500 }], po.po);
    const out = { before, after: await committedLines(po, [f.acc.opex, f.acc.travel]), per: await perItem(po), billed: await billed(po), svc: await svc(po), det: await detail(po) };
    expect(out.svc).toBe(50000);
  });
});

// Its own company: the randomised bills above post travel actuals in June, which would refuse this bill for another reason.
describe('R10-1b the same bill under block', () => {
  let g: BillFixture;
  beforeAll(async () => { g = await seedBillFixture(pool, 'brk-r10-blk'); }, 60_000);
  afterAll(async () => { await dropBillFixture(pool, g); }, 60_000);
  it('travel R500 June (company grain); PO A R100 opex, B R1000 travel, C R100 opex; approved bill A +1000, B +1000, C -900; approve an R200 travel bill under block', async () => {
    await setPolicy(pool, g, 'block');
    try {
      const key = { glAccountId: g.acc.travel, cc1Id: null, cc2Id: null, buId: null, month: '2026-06' };
      const before = (await remainingFor(g.co, [key]))[0]!;
      const po = await seedPo(pool, g, { lines: [100, 1000, 100] });
      await pool.query('UPDATE po_items SET gl_account_id = $1 WHERE id = $2', [g.acc.travel, po.items[1]]);
      await seedRawBill(pool, g, { items: [{ total: 1000, poItem: po.items[0] }, { total: 1000, poItem: po.items[1] }, { total: -900, poItem: po.items[2] }], subtotal: 1100, total: 1265 });
      const r = (await remainingFor(g.co, [key]))[0]!;
      const bill = await makeBill(pool, g, [{ acct: g.acc.travel, amount: 200, cc1: null }], { date: '2026-06-20' });
      const req = await openRequest(pool, g, g.owner);
      const ui = { channel: 'ui' as const, lock: 'take' as const, reason: 'b10', actorRole: 'owner' };
      const res = await req.run(() => approveSupplierInvoice(g.co, bill, g.owner, { budget: ui })).then(() => 'approved', (e: unknown) => (e instanceof BudgetExceededError ? `refused: ${e.message}` : String(e)));
      await req.rollback();
      expect(r.committed - before.committed).toBe(0);
      expect(res).toBe('approved');
    } finally { await setPolicy(pool, g, 'warn'); }
  });
});
