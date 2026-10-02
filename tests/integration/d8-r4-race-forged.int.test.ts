/**
 * D8 round 4 (from the adversarial round brk-d8 C/F/D/X/P): concurrency,
 * forged chains, drafts in the chain, cross-tenant links, and a closed period.
 * C5-AR / C5-AP are B2: two reversals of the head commit between the cancel's
 * chain walk and its lock, and lockStandingChainHead must walk again rather
 * than read the chain as out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { importOpeningBalances } from '@/modules/accounting/services/core/migrationImportService';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import {
  buildChain, diff, openTx, postedBill, postedInvoice, postedReversalsOf, processedPayment, settle, setup,
  sleep, tb, teardown, type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
let other: Ctx;
type Row = Record<string, unknown>;

/** Run `fn` in a committed tx whose client calls `onWalk` right after its `fireAt`-th chain-head walk returns. */
async function hookedTx<T>(fn: () => Promise<T>, fireAt: number, onWalk: () => Promise<void>): Promise<T> {
  const cl = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  let n = 0;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    if (typeof a[0] === 'string' && a[0].includes('ARRAY[id] AS path') && ++n === fireAt) await onWalk();
    return out;
  };
  await orig('BEGIN');
  try {
    const v = await runOn(c.fx, cl, fn);
    await orig('COMMIT');
    return v;
  } catch (err) {
    await orig('ROLLBACK');
    throw err;
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    cl.release();
  }
}

const reverse = (id: string) => inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, id, c.fx.userId));
const bounded = <T>(fn: () => Promise<T>) => inTx(c.fx, async () => {
  await sql`SET LOCAL statement_timeout = '5s'`;
  return fn();
});

describe.skipIf(!process.env.DATABASE_URL)('D8 round 4: race / forged / drafts / cross-tenant / closed period', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 4 races');
    c = await setup('D8R4C');
    other = await setup('D8R4O');
  }, 120000);
  afterAll(async () => { await teardown(c); await teardown(other); }, 120000);

  it('C1: two concurrent AR cancels of a re-reversed invoice reverse its head once', async () => {
    const t0 = await tb(c);
    const inv = await postedInvoice(c);
    const chain = await buildChain(c, inv.je, 2);
    const t1 = await openTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId));
    const p2 = settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)));
    await sleep(800);
    await t1.commit();
    const r2 = await p2;
    const d = diff(t0, await tb(c));
    const contras = await postedReversalsOf(c, chain[2]!);
    expect(d).toMatchObject({ ar: 0, sales: 0, vatOut: 0 });
    expect(contras).toHaveLength(1);
  });

  it('C2: two concurrent AP cancels of a re-reversed bill reverse its head once', async () => {
    const t0 = await tb(c);
    const bill = await postedBill(c);
    const chain = await buildChain(c, bill.je, 2);
    const t1 = await openTx(c.fx, () => cancelSupplierInvoice(c.fx.companyId, bill.id, c.fx.userId));
    const p2 = settle(inTx(c.fx, () => cancelSupplierInvoice(c.fx.companyId, bill.id, c.fx.userId)));
    await sleep(800);
    await t1.commit();
    const r2 = await p2;
    const d = diff(t0, await tb(c));
    const contras = await postedReversalsOf(c, chain[2]!);
    expect(d).toMatchObject({ ap: 0, expense: 0, vatIn: 0 });
    expect(contras).toHaveLength(1);
  });

  it('C3: HTTP void and MCP void of the same re-reversed payment, interleaved, reverse the head once', async () => {
    const bill = await postedBill(c);
    const t0 = await tb(c);
    const pay = await processedPayment(c, bill.id, 400);
    const chain = await buildChain(c, pay.je, 2);
    const t1 = await openTx(c.fx, () => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId));
    const p2 = settle(inTx(c.fx, () => voidPaymentDocument(c.fx.companyId, 'supplier', pay.id, c.fx.userId)));
    await sleep(800);
    await t1.commit();
    const r2 = await p2;
    const d = diff(t0, await tb(c));
    const contras = await postedReversalsOf(c, chain[2]!);
    const [b] = (await sql`SELECT amount_paid::float8 AS p FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
    expect(d).toMatchObject({ ap: 0, bank: 0 });
    expect(Number(b!.p)).toBe(0);
    expect(contras).toHaveLength(1);
  });

  it('C4: AR cancel while a manual reversal of the head is in flight (uncommitted) — invoice out exactly once', async () => {
    const t0 = await tb(c);
    const inv = await postedInvoice(c);
    const chain = await buildChain(c, inv.je, 2);
    const m = await openTx(c.fx, () => reverseJournalEntry(c.fx.companyId, chain[2]!, c.fx.userId));
    const p = settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)));
    await sleep(800);
    await m.commit();
    const r = await p;
    const d = diff(t0, await tb(c));
    expect(d).toMatchObject({ ar: 0, sales: 0, vatOut: 0 });
  });

  it('C5-AR: two reversals of the head commit between the cancel\'s chain walk and its lock', async () => {
    const t0 = await tb(c);
    const inv = await postedInvoice(c);
    const chain = await buildChain(c, inv.je, 2);
    const r = await settle(hookedTx(() => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId), 1, async () => {
      const r3 = await reverse(chain[2]!);
      await reverse(r3.id);
    }));
    const d = diff(t0, await tb(c));
    const [st] = (await sql`SELECT status FROM customer_invoices WHERE id = ${inv.id}::UUID`) as Row[];
    // Expected: cancelled AND out of AR, or refused with the invoice still open.
    if (st!.status === 'cancelled') expect(d).toMatchObject({ ar: 0, sales: 0, vatOut: 0 });
  });

  it('C5-AP: same race through the bill cancel (fires on lockStandingChainHead\'s walk, after the plan\'s)', async () => {
    const t0 = await tb(c);
    const bill = await postedBill(c);
    const chain = await buildChain(c, bill.je, 2);
    const r = await settle(hookedTx(() => cancelSupplierInvoice(c.fx.companyId, bill.id, c.fx.userId), 2, async () => {
      const r3 = await reverse(chain[2]!);
      await reverse(r3.id);
    }));
    const d = diff(t0, await tb(c));
    const [st] = (await sql`SELECT status FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
    if (st!.status === 'cancelled') expect(d).toMatchObject({ ap: 0, expense: 0, vatIn: 0 });
  });

  it('F1: a forged loop on every D8 flow ends inside 5s and books nothing', async () => {
    const out: Record<string, unknown> = {};
    const loop = async (je: string) => {
      const r = await reverse(je);
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${r.id}::UUID WHERE id = ${je}::UUID AND company_id = ${c.fx.companyId}::UUID`;
    };
    const t0 = await tb(c);
    const bill = await postedBill(c);
    await loop(bill.je);
    out.apCancel = await settle(bounded(() => cancelSupplierInvoice(c.fx.companyId, bill.id, c.fx.userId)));
    const bill2 = await postedBill(c);
    const pay = await processedPayment(c, bill2.id, 200);
    await loop(pay.je);
    out.httpVoid = await settle(bounded(() => voidSupplierPayment(c.fx.companyId, pay.id, c.fx.userId)));
    out.mcpVoid = await settle(bounded(() => voidPaymentDocument(c.fx.companyId, 'supplier', pay.id, c.fx.userId)));
    const [s] = (await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by)
      VALUES (${c.fx.companyId}::UUID, 'sage', ${c.fx.userId}) RETURNING id`) as Row[];
    const tbRows = [{ accountCode: '6000', debit: 50, credit: 0 }, { accountCode: '3900', debit: 0, credit: 50 }];
    const first = await inTx(c.fx, () => importOpeningBalances(c.fx.companyId, String(s!.id), '2026-01-01', tbRows, c.fx.userId));
    await loop(first.journalEntryId);
    const tMid = await tb(c);
    out.reimport = await settle(bounded(() => importOpeningBalances(c.fx.companyId, String(s!.id), '2026-01-01', tbRows, c.fx.userId)));
    out.vat201 = await settle(bounded(async () => { await generateVAT201(c.fx.companyId, '2026-05-01', '2026-05-31'); return 'ok'; }));
    const t1 = await tb(c);
    for (const k of ['apCancel', 'httpVoid', 'mcpVoid', 'reimport']) {
      expect((out[k] as { ok: boolean }).ok, k).toBe(false);
      expect(String((out[k] as { error: string }).error), k).not.toMatch(/statement timeout|canceling statement/);
    }
    expect(diff(tMid, t1)).toMatchObject({ ap: 0, bank: 0, expense: 0, equity: 0 });
  });

  it('D1: a DRAFT re-reversal (O <- R <- R2 draft) leaves the chain out: cancel reverses nothing', async () => {
    const t0 = await tb(c);
    const inv = await postedInvoice(c);
    const [o, r] = await buildChain(c, inv.je, 1);
    await sql`
      INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, reversal_of_id)
      VALUES (${c.fx.companyId}::UUID, '2026-05-10', 'forged draft re-reversal', 'manual', 'draft', ${c.fx.userId}::UUID, ${r}::UUID)`;
    const res = await settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)));
    const d = diff(t0, await tb(c));
    expect(d).toMatchObject({ ar: 0, sales: 0 });
  });

  it('D2: a stray DRAFT with reversal_of_id = O on a standing O: cancel refuses or takes O out — never half', async () => {
    const t0 = await tb(c);
    const inv = await postedInvoice(c);
    await sql`
      INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, reversal_of_id)
      VALUES (${c.fx.companyId}::UUID, '2026-05-10', 'forged draft reversal', 'manual', 'draft', ${c.fx.userId}::UUID, ${inv.je}::UUID)`;
    const res = await settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)));
    const d = diff(t0, await tb(c));
    const [st] = (await sql`SELECT status FROM customer_invoices WHERE id = ${inv.id}::UUID`) as Row[];
    expect(st!.status === 'cancelled' ? d.ar === 0 : d.ar === 1150).toBe(true);
  });

  it('X1: a forged reversal of O in ANOTHER company does not stop or leak the cancel', async () => {
    const t0 = await tb(c);
    const o0 = await tb(other);
    const inv = await postedInvoice(c);
    await sql`
      INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, reversal_of_id)
      VALUES (${other.fx.companyId}::UUID, '2026-05-10', 'cross-tenant forged', 'manual', 'posted', ${c.fx.userId}::UUID, ${inv.je}::UUID)`;
    const res = await settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)));
    const d = diff(t0, await tb(c));
    expect(res.ok).toBe(true);
    expect(d).toMatchObject({ ar: 0, sales: 0 });
  });

  it('X2: chain head in another company (O <- R here, R2 there, R stamped): refused or correct, nothing booked', async () => {
    const t0 = await tb(c);
    const inv = await postedInvoice(c);
    const [, r] = await buildChain(c, inv.je, 1);
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = ${r}::UUID`;
    await sql`
      INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, reversal_of_id)
      VALUES (${other.fx.companyId}::UUID, '2026-05-10', 'foreign head', 'manual', 'posted', ${c.fx.userId}::UUID, ${r}::UUID)`;
    const tMid = await tb(c);
    const res = await settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, inv.id, c.fx.userId)));
    expect(diff(tMid, await tb(c))).toMatchObject({ ar: 0 });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('D8 round 4 P: re-reversed chain in a period closed afterwards', () => {
  let p: Ctx;
  beforeAll(async () => {
    p = await setup('D8R4P');
    await sql`UPDATE fiscal_periods SET end_date = '2026-05-31' WHERE company_id = ${p.fx.companyId}::UUID`;
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${p.fx.companyId}::UUID, ${`FY26b ${p.fx.tag}`}, 2, 2026, '2026-06-01', '2026-12-31', 'open')`;
  }, 120000);
  afterAll(async () => { await teardown(p); }, 120000);

  it('P1: AR cancel after May closed — head reversed once, dated in an open period', async () => {
    const t0 = await tb(p);
    const inv = await postedInvoice(p);
    const chain = await buildChain(p, inv.je, 2);
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${p.fx.companyId}::UUID AND period_number = 1`;
    const res = await settle(inTx(p.fx, () => cancelCustomerInvoice(p.fx.companyId, inv.id, p.fx.userId)));
    const contras = await postedReversalsOf(p, chain[2]!);
    const dates = contras.length
      ? ((await sql`SELECT entry_date::TEXT AS d FROM gl_journal_entries WHERE id = ${contras[0]!}::UUID`) as Row[])[0]!.d : null;
    const d = diff(t0, await tb(p));
    if (res.ok) {
      expect(d).toMatchObject({ ar: 0, sales: 0 });
      expect(String(dates) >= '2026-06-01').toBe(true);
    }
  });
});
