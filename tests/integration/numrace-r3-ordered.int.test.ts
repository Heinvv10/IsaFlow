/**
 * NUMRACE round 3 — ORDERED LAZY (Hein's ruling 2026-10-06; core/numberYearLocks.ts).
 *
 *   - The goal's acceptance case: two bulk_allocate runs over disjoint lines crossing the year end in OPPOSITE id
 *     order, interleaved by the numrace gate (the brk-docnum A3 shape). Each now walks its lines by year, so both
 *     reach 2025 before 2026: one waits, neither deadlocks.
 *   - brk-numrace N2: a supplier bulk approve of a bill dated in a filed VAT period whose slip a bank-first
 *     provisional (dated 2024) already booked posts the R-127 settlement reclass dated on the PROVISIONAL — a year below
 *     the bill's. Round 2's prediction missed it, so the run took 2024's key after 2025's/2026's; against a peer that
 *     holds 2024 and then wants 2025, a deadlock. Now the prediction holds 2024 (ap/supplierInvoiceYears), the bill is
 *     walked first, and its multi-year range is taken ascending before its rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import supplierBulk from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { openYear } from './helpers/jenumFixture';
import { lockPeriod } from './helpers/vatLateClaimFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { dropGate, holdGate, installGate, settle, waitBlocked, waitBlockedBy, type Settled } from './helpers/numraceGate';
import {
  ascendingPeerVs, bulkAllocate, deadlocks, dropCrossYear, line, postedCount, seedCrossYear, txn, type CrossYear,
} from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const made: { c: CrossYear; routeUser: boolean }[] = [];
type Row = Record<string, unknown>;

async function fixture(routeUser = false) {
  const c = await seedCrossYear('NUMRACE-OL', DATABASE_URL!);
  made.push({ c, routeUser });
  return { c, token: routeUser ? await seedRouteUser(c.fx, 'numrace-ol') : '' };
}

const bodyOf = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as { posted: number };

describeIfDb('NUMRACE r3: ordered lazy', () => {
  beforeAll(() => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
  });

  afterAll(async () => {
    for (const { c, routeUser } of made) {
      await dropGate(c.fx.pool, 'gl_journal_entries').catch(() => undefined);
      await sql`DELETE FROM supplier_payment_allocations WHERE payment_id IN (
        SELECT id FROM supplier_payments WHERE company_id = ${c.fx.companyId}::UUID)`.catch(() => undefined);
      await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
        SELECT id FROM supplier_invoices WHERE company_id = ${c.fx.companyId}::UUID)`;
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL, source_document_id = NULL
        WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`UPDATE gl_journal_entries SET source_document_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      if (routeUser) await dropRouteUser(c.fx);
      await dropCrossYear(c);
      await dropFixture(c.fx).catch(() => undefined);
      await sql`DELETE FROM captured_documents WHERE company_id = ${c.fx.companyId}::UUID`.catch(() => undefined);
    }
  }, 120000);

  it('two bulk allocates over disjoint lines, id order crossing the year end in opposite directions: no deadlock', async () => {
    const { c } = await fixture();
    await installGate(c.fx.pool, 'gl_journal_entries', 'description');
    const x26 = await line(c, '11111111', '2026-01-06', 'NROL x26');
    const x25 = await line(c, '22222222', '2025-12-29', 'NROL x25');
    const y25 = await line(c, '33333333', '2025-12-28', 'NROL y25');
    const y26 = await line(c, '44444444', '2026-01-07', 'NROL y26');
    const before = await deadlocks(c);
    const g1 = await holdGate(c.fx.pool, 1);
    const g2 = await holdGate(c.fx.pool, 2);
    const t1 = await txn(c), t2 = await txn(c);
    let r1!: Settled<Awaited<ReturnType<typeof bulkAllocate>>>, r2!: Settled<Awaited<ReturnType<typeof bulkAllocate>>>;
    try {
      // In id order t1 would post 2026 first and t2 2025 first; each stops at its gate holding that key.
      const p1 = settle(t1.run(() => bulkAllocate(c, [{ id: x26, description: 'ngate:1 x26' }, { id: x25 }])));
      const p2 = settle(t2.run(() => bulkAllocate(c, [{ id: y25, description: 'ngate:2 y25' }, { id: y26 }])));
      await waitBlocked(c.fx.pool, t1.pid);
      await waitBlocked(c.fx.pool, t2.pid);
      await g1.open();
      await g2.open();
      [r1, r2] = [await p1, await p2];
    } finally {
      await g1.open();
      await g2.open();
      await t1.abandon();
      await t2.abandon();
    }
    await new Promise((r) => setTimeout(r, 1200));
    const after = await deadlocks(c);
    process.stdout.write(`OL-accept ${JSON.stringify({ r1, r2, deadlocks: { before, after } })}\n`);
    expect(r1.ok ? bodyOf(r1.value).posted : r1).toBe(2);
    expect(r2.ok ? bodyOf(r2.value).posted : r2).toBe(2);
    expect(await postedCount([x26, x25, y25, y26])).toBe(4);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 120000);

  it('N2: bulk approve of a filed-period bill settling a 2024 provisional, vs a peer holding 2024 then wanting 2025', async () => {
    const { c, token } = await fixture(true);
    await openYear(c.fx, 2024);
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, '1145', ${`Input VAT - late claims ${c.fx.tag}`}, 'asset',
        'vat_input_late_claim', 'debit', true, true)`;
    clearSystemAccountCache(c.fx.companyId);
    const vatInput = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${c.fx.companyId}::UUID
      AND account_code = '1140'`) as Row[])[0]!.id);
    // The slip: a captured document a bank-first provisional (dated 2024-10-10) already booked, VAT included.
    const doc = crypto.randomUUID(), je = crypto.randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, extracted_data, status,
        posted_at, raw_bytes_sha256)
      VALUES (${doc}::UUID, ${c.fx.companyId}::UUID, 'n2.pdf', 'application/pdf', 'invoice', '{}'::jsonb, 'posted', NOW(),
        ${crypto.randomUUID().replace(/-/g, '')})`;
    await sql`INSERT INTO gl_journal_entries (id, company_id, entry_date, description, source, status, created_by,
        posting_agent, needs_evidence, source_document_id)
      VALUES (${je}::UUID, ${c.fx.companyId}::UUID, '2024-10-10', 'N2 provisional', 'auto_bank_recon', 'draft',
        ${c.fx.userId}::UUID, 'ai-evidenced:v1', false, ${doc}::UUID)`;
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
      VALUES (${c.fx.companyId}::UUID, ${je}::UUID, ${c.expense}::UUID, 1000, 0, 'N2 expense', NULL),
             (${c.fx.companyId}::UUID, ${je}::UUID, ${vatInput}::UUID, 150, 0, 'N2 VAT', 'standard'),
             (${c.fx.companyId}::UUID, ${je}::UUID, ${c.fx.bankAccountId}::UUID, 0, 1150, 'N2 bank', NULL)`;
    await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW(), posted_by = ${c.fx.userId}::UUID
      WHERE id = ${je}::UUID`;
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
        provisional_je_id)
      VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2024-10-10', -1150, 'N2 slip', 'matched', ${je}::UUID)`;
    const bill = async (date: string, n: string) => String(((await inTx(c.fx, () => createSupplierInvoice(
      c.fx.companyId, { supplierId: c.fx.supplierId, invoiceNumber: `NRN2-${n}-${c.fx.tag}`.slice(0, 50), invoiceDate: date,
        items: [{ description: 'n2', quantity: 1, unitPrice: 1000, taxRate: 15, glAccountId: c.expense }] },
      c.fx.userId))) as { id: string }).id);
    const bN = await bill('2025-03-15', 'filed');
    const b26 = await bill('2026-01-15', 'later');
    await sql`UPDATE supplier_invoices SET source_document_id = ${doc}::UUID WHERE id = ${bN}::UUID`;
    await lockPeriod(c.fx, '2025-03-01', '2025-04-30');

    const { rp, rr, before, after } = await ascendingPeerVs(c,
      () => callRoute(c.fx, token, supplierBulk, { action: 'approve', invoiceIds: [b26, bN] }), ['2024-11-01', '2025-11-01']);
    const jes = (await sql`SELECT entry_date::text AS d, source FROM gl_journal_entries
      WHERE company_id = ${c.fx.companyId}::UUID AND description NOT LIKE 'jenum %' ORDER BY entry_date`) as Row[];
    process.stdout.write(`OL-N2 ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after }, jes })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    const results = rr.ok ? ((rr.value as { body: { data: { results: { ok: boolean }[] } } }).body.data.results) : [];
    expect(results.map((r) => r.ok), JSON.stringify(rr)).toEqual([true, true]);
    expect(jes.some((j) => j.d === '2024-10-10' && j.source !== 'auto_bank_recon'), 'the reclass was dated 2024').toBe(true);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 120000);
});
