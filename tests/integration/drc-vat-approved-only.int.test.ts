/**
 * applyDRCVat against a real ledger.
 *
 * DRC VAT self-assesses input and output VAT on a supplier bill. It checked no
 * status, so it posted on DRAFTS — a bill whose figures can still change. It
 * also read `is_drc` without a lock, so two concurrent calls could both post,
 * and the route turns every throw into a 400, which `withAuth` COMMITS, so a
 * failure after the journal was created left it behind. These pin those three
 * plus soft-deleted and foreign bills. The journal is still not linked on the
 * bill (`gl_journal_entry_id`); nothing here claims otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { applyDRCVat, getDRCEligibleInvoices } from '@/modules/accounting/services/reports/drcVatService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, runOn, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
let seq = 0;
type Row = Record<string, unknown>;

const bill = (status: string, f: Fixture = fx) =>
  seedBill(f, { number: `DRC${++seq}`, date: '2026-05-01', total: 1150, status });

async function state(id: string): Promise<{ isDrc: boolean; journals: number }> {
  const [b] = (await sql`SELECT is_drc FROM supplier_invoices WHERE id = ${id}::UUID`) as Row[];
  const [j] = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE source_record_id = ${id}::UUID`) as Row[];
  return { isDrc: b!.is_drc === true, journals: Number(j!.n) };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

/** The route's shape: a caught throw still COMMITS the request transaction. */
async function asRoute(f: Fixture, id: string): Promise<string | null> {
  const c = await f.pool.connect();
  await c.query('BEGIN');
  try {
    const msg = await runOn(f, c, () =>
      applyDRCVat(f.companyId, id, f.userId).then(() => null, (e: unknown) => (e as Error).message));
    await c.query('COMMIT');
    return msg;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

describeIfDb('applyDRCVat — approved bills only, once, all-or-nothing', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts DRC VAT journals.');
    fx = await seedFixture('DRC', DATABASE_URL!);
    other = await seedFixture('DRX', DATABASE_URL!);
    // seedBill writes no subtotal split; DRC is computed on the subtotal.
    await sql`UPDATE supplier_invoices SET subtotal = 1000 WHERE company_id = ${fx.companyId}::UUID`;
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) await dropFixture(f);
  }, 120000);

  it('refuses every status outside the allow-list, naming it, and writes nothing', async () => {
    for (const status of ['draft', 'pending_approval', 'disputed', 'cancelled']) {
      const id = await bill(status);
      expect(await refusal(inTx(fx, () => applyDRCVat(fx.companyId, id, fx.userId)))).toContain(status);
      expect(await state(id)).toEqual({ isDrc: false, journals: 0 });
    }
  });

  it('posts once on an approved bill, then refuses a second application', async () => {
    const id = await bill('approved');
    await sql`UPDATE supplier_invoices SET subtotal = 1000 WHERE id = ${id}::UUID`;
    const r = await inTx(fx, () => applyDRCVat(fx.companyId, id, fx.userId));
    expect(r.vatAmount).toBe(150);
    expect(await state(id)).toEqual({ isDrc: true, journals: 1 });
    expect(await refusal(inTx(fx, () => applyDRCVat(fx.companyId, id, fx.userId)))).toContain('already applied');
    expect((await state(id)).journals).toBe(1);
  });

  it('a second application while the first is still uncommitted waits, then refuses', async () => {
    const id = await bill('approved');
    await sql`UPDATE supplier_invoices SET subtotal = 1000 WHERE id = ${id}::UUID`;
    const a = await fx.pool.connect();
    const b = await fx.pool.connect();
    try {
      await a.query('BEGIN');
      await runOn(fx, a, () => applyDRCVat(fx.companyId, id, fx.userId));
      // A has posted but not committed. B starts now: with the row lock it
      // blocks until A commits and then reads is_drc = true; without it, B
      // reads the committed is_drc = false and goes on to post a second one.
      await b.query('BEGIN');
      const second = runOn(fx, b, () =>
        applyDRCVat(fx.companyId, id, fx.userId).then(() => null, (e: unknown) => (e as Error).message));
      await new Promise((r) => setTimeout(r, 300));
      await a.query('COMMIT');
      const msg = await second;
      await b.query('COMMIT');
      expect(msg).toContain('already applied');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
    expect(await state(id)).toEqual({ isDrc: true, journals: 1 });
  });

  it('answers not found for a soft-deleted bill and for another tenant\'s bill', async () => {
    const deleted = await bill('approved');
    await sql`UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = ${deleted}::UUID`;
    expect(await refusal(inTx(fx, () => applyDRCVat(fx.companyId, deleted, fx.userId)))).toContain('not found');
    const foreign = await bill('approved', other);
    expect(await refusal(inTx(fx, () => applyDRCVat(fx.companyId, foreign, fx.userId)))).toContain('not found');
    expect(await state(foreign)).toEqual({ isDrc: false, journals: 0 });
  });

  it('a failure after the journal is created leaves nothing behind, even though the route commits', async () => {
    const id = await bill('approved');
    await sql`UPDATE supplier_invoices SET subtotal = 1000 WHERE id = ${id}::UUID`;
    // Posting refuses into a closed period; creating the draft does not check it.
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${fx.companyId}::UUID`;
    try {
      expect(await asRoute(fx, id)).not.toBeNull();
    } finally {
      await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${fx.companyId}::UUID`;
    }
    expect(await state(id)).toEqual({ isDrc: false, journals: 0 });
  });

  /**
   * Approval already posted DR Input VAT = tax_amount. DRC posting DR Input VAT
   * again on the subtotal claims the same input VAT twice. A reverse-charge
   * invoice carries no supplier VAT, so a taxed bill is not one.
   */
  it('refuses a bill that already carries supplier VAT, and does not list it', async () => {
    const taxed = await bill('approved');
    await sql`UPDATE supplier_invoices SET subtotal = 1000, tax_amount = 150 WHERE id = ${taxed}::UUID`;
    const clean = await bill('approved');
    await sql`UPDATE supplier_invoices SET subtotal = 1000, tax_amount = 0 WHERE id = ${clean}::UUID`;

    const msg = await refusal(inTx(fx, () => applyDRCVat(fx.companyId, taxed, fx.userId)));
    expect(msg).toContain('R150.00');
    expect(await state(taxed)).toEqual({ isDrc: false, journals: 0 });

    const listed = (await inTx(fx, () => getDRCEligibleInvoices(fx.companyId))).map((i) => i.id);
    expect(listed).toContain(clean);
    expect(listed).not.toContain(taxed);
  });
});
