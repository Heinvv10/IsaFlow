/**
 * D7 round 3 (ported from brk-d7 S1/S1b/S2) — every reversal-chain walk ends
 * on a forged cycle, and stays inside its own tenant.
 *
 * `reversal_of_id` carries no constraint that stops a loop, and the walks in
 * shared/softDeleteLedgerPresence recursed with `UNION ALL` and no guard. One
 * forged loop O <-> R on ONE deleted invoice hung every VAT reconciliation and
 * the AR reconciliation (the parity walk the subledger and aging use, on master
 * too) for the whole company, and one on a LIVE invoice hung the VAT201
 * unposted check. The queries carried on server-side after the client gave up,
 * spilling temp files by the gigabyte.
 *
 * Each case asserts that the call FINISHES, well inside a bound, AND what it
 * returns: the cycle row is dropped and the rest of the chain is read as usual.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatReconciliation } from '@/modules/accounting/services/reports/vatReconciliationService';
import { findUnpostedInvoiceVat } from '@/modules/accounting/services/reports/vatUnpostedInvoices';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { type Co, makeCompany, cleanup, inTx, arInvoice, journalOf, reverseTip } from './k053-chain.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const BOUND_MS = 5000;

/** The call's result, or a thrown error naming the call that did not finish in time. */
async function finishes<T>(label: string, call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} still running after ${BOUND_MS}ms`)), BOUND_MS);
  });
  try {
    return await Promise.race([call(), bound]);
  } finally {
    clearTimeout(timer);
  }
}

async function reversalOf(co: Co, journal: string): Promise<string> {
  return ((await sql`SELECT id FROM gl_journal_entries
    WHERE company_id = ${co.id}::UUID AND reversal_of_id = ${journal}::UUID`) as { id: string }[])[0]!.id;
}

/** Forge `journal` into reversing `target`, closing a loop. */
async function forgeLink(co: Co, journal: string, target: string | null): Promise<void> {
  await sql`UPDATE gl_journal_entries SET reversal_of_id = ${target}::UUID
            WHERE company_id = ${co.id}::UUID AND id = ${journal}::UUID`;
}

describeIfDb('D7 reversal-chain walks: cycle guard and tenant scope', () => {
  const cos: Co[] = [];
  beforeAll(() => { assertDisposable(); });
  afterAll(async () => { for (const c of cos) await cleanup(c); }, 120000);

  it('S1: a forged loop on a DELETED invoice — VAT recon, VAT201, AR recon and aging all finish', async () => {
    const co = await makeCompany('D7S1'); cos.push(co);
    await arInvoice(co, '-live', '2026-07-10', 300, 45);
    const del = await arInvoice(co, '-del', '2026-07-12', 1000, 150);
    const o = await journalOf(co, del);
    await inTx(co, () => softDelete(co.id, 'customer_invoice', del, co.user));
    await forgeLink(co, o, await reversalOf(co, o)); // O <-> R

    const recon = await finishes('VAT recon', () => getVatReconciliation(co.id, '2026-07-01', '2026-07-31'));
    // Revenue: O stays (it is the document's own journal), R is a chain link.
    // VAT: the ledger, O and R netting off.
    expect(recon.months.map((m) => [m.month, m.glRevenue, m.glOutputVat, m.revenueVariance]))
      .toEqual([['2026-07', 1300, 45, 0]]);
    expect(await finishes('VAT201 unposted', () => findUnpostedInvoiceVat(co.id, '2026-07-01', '2026-07-31'))).toEqual([]);
    const ar = await finishes('AR recon', () => reconcileSubledger(co.id, 'ar', '2026-07-31'));
    expect([ar.subledgerTotal, ar.controlAccountBalance, ar.unexplainedDifference, ar.reconcilingItems.length])
      .toEqual([345, 345, 0, 0]);
    const aged = await finishes('AR aging', () => getARAging(co.id, '2026-07-31'));
    expect(aged.find((b) => b.entityId === co.customer)?.total).toBe(345);
    await forgeLink(co, o, null);
  }, 60000);

  it('S1b: a forged loop on a LIVE invoice — the VAT201 check finishes and reads the one real reversal', async () => {
    const co = await makeCompany('D7S1B'); cos.push(co);
    const live = await arInvoice(co, '-live', '2026-07-10', 1000, 150);
    const o = await journalOf(co, live);
    const m = await reverseTip(co, o, '2026-07-20');
    await forgeLink(co, o, m); // O <-> M

    const listed = await finishes('VAT201 unposted', () => findUnpostedInvoiceVat(co.id, '2026-07-01', '2026-07-31'));
    expect(listed.map((r) => r.reason)).toEqual(['journal_reversed']);
    const ar = await finishes('AR recon', () => reconcileSubledger(co.id, 'ar', '2026-07-31'));
    expect(ar.unexplainedDifference).toBe(0);
    await forgeLink(co, o, null);
  }, 60000);

  it('S2: another tenant\'s entry forged into this tenant\'s chain moves nothing on either side', async () => {
    const a = await makeCompany('D7S2A'); cos.push(a);
    const b = await makeCompany('D7S2B'); cos.push(b);
    const inv = await arInvoice(a, '-del', '2026-07-12', 1000, 150);
    await inTx(a, () => softDelete(a.id, 'customer_invoice', inv, a.user));
    const r = await reversalOf(a, await journalOf(a, inv));
    const snapshot = async () => JSON.stringify([
      await getVatReconciliation(a.id, '2026-07-01', '2026-07-31'),
      (await reconcileSubledger(a.id, 'ar', '2026-07-31')).reconcilingItems,
    ]);
    const before = await snapshot();
    const bo = await journalOf(b, await arInvoice(b, '-x', '2026-07-15', 500, 75));
    await forgeLink(b, bo, r);

    expect(await snapshot()).toBe(before);
    const bRecon = await getVatReconciliation(b.id, '2026-07-01', '2026-07-31');
    expect(bRecon.months.map((m) => [m.glRevenue, m.glOutputVat])).toEqual([[500, 75]]);
    await forgeLink(b, bo, null);
  }, 60000);
});
