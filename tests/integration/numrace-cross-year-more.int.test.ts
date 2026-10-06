/**
 * NUMRACE: the other single-transaction multi-journal posters the census found (beyond bulk allocate, the rule
 * pass, the auto-post sweep and the bulk-approve runner) take every year's journal key up front, ascending:
 *   - POST /api/accounting/gl-import (glImportExecuteService): groups post in FILE order;
 *   - post_reclassification_batch (reclassification/post.ts): drafts post in caller order;
 *   - POST /api/accounting/supplier-invoices-bulk-action: bills post in id order, each in its own savepoint.
 *
 * gl-import and reclassification have no per-journal savepoint, so a held year already failed them whole; what
 * changes is the deadlock: a run walking 2026 then 2025 against a peer holding 2025 that then wants 2026 (the
 * shape of helpers/numraceCrossYear.ascendingPeerVs) was a 40P01 and is now a wait. The bulk-action route skipped
 * a held bill per item; with its year taken up front a held year now answers 503 for the whole request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import glImport from '../../pages/api/accounting/gl-import';
import supplierBulk from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { postReclassBatch } from '@/modules/accounting/services/gl/reclassification/post';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, seedBill } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { holdKey } from './helpers/numraceGate';
import { ascendingPeerVs, dropCrossYear, seedCrossYear, type CrossYear } from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const made: { c: CrossYear; routeUser: boolean }[] = [];
type Out = Awaited<ReturnType<typeof callRoute>> & { getHeader?: (n: string) => unknown };

async function fixture(routeUser = false): Promise<{ c: CrossYear; token: string }> {
  const c = await seedCrossYear('NUMRACE-M', DATABASE_URL!);
  made.push({ c, routeUser });
  return { c, token: routeUser ? await seedRouteUser(c.fx, 'numrace-m') : '' };
}

const row = (date: string, ref: string, accountCode: string, debit: number, credit: number) =>
  ({ date, reference: ref, accountCode, description: `numrace ${ref}`, debit, credit });

describeIfDb('NUMRACE: gl-import, reclassification and the supplier bulk action across a year end', () => {
  beforeAll(() => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
  });

  afterAll(async () => {
    for (const { c, routeUser } of made) {
      await sql`DELETE FROM reclassification_batches WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
        SELECT id FROM supplier_invoices WHERE company_id = ${c.fx.companyId}::UUID)`;
      if (routeUser) await dropRouteUser(c.fx);
      await dropCrossYear(c);
      await dropFixture(c.fx);
    }
  }, 60000);

  it('gl-import of a file whose 2026 group comes first vs an ascending two-year poster: both commit', async () => {
    const { c, token } = await fixture(true);
    const rows = [
      row('2026-01-05', 'NR-26', '6000', 10, 0), row('2026-01-05', 'NR-26', '1000', 0, 10),
      row('2025-12-20', 'NR-25', '6000', 10, 0), row('2025-12-20', 'NR-25', '1000', 0, 10),
    ];
    const { rp, rr, before, after } = await ascendingPeerVs(c, () =>
      callRoute(c.fx, token, glImport, { rows, postImmediately: true }));
    process.stdout.write(`M-glimport ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok ? (rr.value as Out).statusCode : rr).toBe(200);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('a reclassification batch whose 2026 draft comes first vs an ascending two-year poster: both commit', async () => {
    const { c } = await fixture();
    const draft = (date: string) => ({
      date, description: `numrace reclass ${date}`, sourceLineIds: [], totalDebit: 3, totalCredit: 3,
      lines: [
        { glAccountId: c.expense, debit: 3, credit: 0, description: 'nr DR' },
        { glAccountId: c.fx.bankAccountId, debit: 0, credit: 3, description: 'nr CR' },
      ],
    });
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => postReclassBatch(c.fx.companyId, c.fx.userId, {
      tool: 'numrace', sourceAccountId: c.fx.bankAccountId, targetAccountId: c.expense, postingDate: null,
      idempotencyKey: null, drafts: [draft('2026-02-01'), draft('2025-11-01')] as never,
    }));
    process.stdout.write(`M-reclass ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok ? (rr.value as { journals: unknown[] }).journals.length : rr).toBe(2);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  it('supplier-invoices-bulk-action approve, bills in 2025 and 2026, 2025 held: 503 + Retry-After, nothing approved', async () => {
    const { c, token } = await fixture(true);
    const b25 = await seedBill(c.fx, { number: 'NR-B25', date: '2025-12-15', total: 100, status: 'draft' });
    const b26 = await seedBill(c.fx, { number: 'NR-B26', date: '2026-01-15', total: 100, status: 'draft' });
    // One zero-rated line each, so an approval can build its journal (the bill's own date).
    await sql`INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate,
        tax_amount, line_total, gl_account_id)
      SELECT id, 'numrace', 1, 100, 0, 0, 100, ${c.expense}::UUID FROM supplier_invoices
      WHERE id IN (${b25}::UUID, ${b26}::UUID)`;
    const held = await holdKey(c.fx.pool, `${c.fx.companyId}:2025`, 857);
    let out: Out;
    try {
      out = await callRoute(c.fx, token, supplierBulk, { action: 'approve', invoiceIds: [b25, b26] });
    } finally {
      await held.open();
    }
    expect(out.statusCode, JSON.stringify(out.body)).toBe(503);
    expect(out.getHeader?.('retry-after')).toBe('2');
    const st = (await sql`SELECT status FROM supplier_invoices WHERE id IN (${b25}::UUID, ${b26}::UUID)`) as
      { status: string }[];
    expect(st.map((r) => r.status)).toEqual(['draft', 'draft']);
  }, 60000);
});
