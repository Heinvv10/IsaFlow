/**
 * NUMRACE round 2: brk-numrace's attacks on 6fa53c672 (agents/brk-numrace), kept as regression tests. Each asserts
 * the shape stays deadlock-free (pg_stat_database.deadlocks flat) or keeps its base answer. Attack A (bulk-commit) is
 * driven through the real route in numrace-r2-bulk-commit.int.test.ts instead: the fix is in the route. Run with
 * --no-file-parallelism on a disposable fixture (the counter is database-wide). The late-claim case (E) needs
 * 'auto_vat_late_claim' in gl_journal_entries_source_check (migration 701).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  approveSupplierInvoice, cancelSupplierInvoice,
} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importARInvoices } from '@/modules/accounting/services/core/migrationImportService';
import { importAPInvoices } from '@/modules/accounting/services/ap/migrationApService';
import supplierBulk from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { openYear } from './helpers/jenumFixture';
import { lockPeriod } from './helpers/vatLateClaimFixture';
import { callRoute, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { holdKey, settle, waitBlockedBy } from './helpers/numraceGate';
import {
  ascendingPeerVs, bulkAllocate, deadlocks, dropCrossYear, line, seedCrossYear, txn, type CrossYear,
} from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const made: CrossYear[] = [];
type Row = Record<string, unknown>;

async function fixture(prefix: string): Promise<CrossYear> {
  const c = await seedCrossYear(prefix, DATABASE_URL!);
  made.push(c);
  return c;
}

async function billWithVat(c: CrossYear, date: string, n: string): Promise<string> {
  const inv = await inTx(c.fx, () => createSupplierInvoice(c.fx.companyId, {
    supplierId: c.fx.supplierId, invoiceNumber: `BRK-${n}-${c.fx.tag}`.slice(0, 50), invoiceDate: date,
    items: [{ description: 'brk', quantity: 1, unitPrice: 1000, taxRate: 15, glAccountId: c.expense }],
  }, c.fx.userId));
  return String((inv as { id: string }).id);
}

const out = (tag: string, v: unknown) => process.stdout.write(`${tag} ${JSON.stringify(v)}\n`);

describeIfDb('brk-numrace attacks', () => {
  beforeAll(() => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
  });

  afterAll(async () => {
    for (const c of made) {
      await dropCrossYear(c).catch(() => undefined);
      await dropFixture(c.fx).catch(() => undefined);
    }
  }, 60000);

  // NEW PAIR: a cross-year bulk allocate now holds both year keys BEFORE its first bank-line row lock. A single
  // allocation of that line (row lock, then its journal number) used to serialise on the row; now it cycles.
  it('B: bulk allocate [L1 2025, L2 2026] vs a single allocation holding L1: no deadlock', async () => {
    const c = await fixture('BRK-B');
    const l1 = await line(c, '11111111', '2025-12-20', 'NRB one');
    const l2 = await line(c, '22222222', '2026-01-05', 'NRB two');
    const before = await deadlocks(c);
    const p = await txn(c);
    const r = await txn(c);
    let go!: () => void, locked!: () => void;
    const goP = new Promise<void>((res) => { go = res; });
    const lockedP = new Promise<void>((res) => { locked = res; });
    try {
      const pP = settle(p.run(async () => {
        await sql`SELECT id FROM bank_transactions WHERE id = ${l1}::UUID FOR UPDATE`;
        locked();
        await goP;
        return allocateTransaction(c.fx.companyId, l1, c.expense, c.fx.userId, undefined, 'account', undefined,
          undefined);
      }));
      await lockedP;
      const pR = settle(r.run(() => bulkAllocate(c, [{ id: l1 }, { id: l2 }])));
      await waitBlockedBy(c.fx.pool, p.pid);
      go();
      const [rp, rr] = [await pP, await pR];
      await new Promise((res) => setTimeout(res, 1500));
      const after = await deadlocks(c);
      out('B', { rp: rp.ok ? 'ok' : rp, rr: rr.ok ? (rr.value as { content: { text: string }[] }).content[0]!.text : rr,
        deadlocks: { before, after } });
      expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
    } finally {
      go();
      await p.abandon();
      await r.abandon();
    }
  }, 90000);

  // NEW PAIR, single-year data: a bulk CANCEL adds this year, so one 2025 bill is now a "two-year" run that takes
  // both keys before the bill's row lock. The single cancel (row lock, then its reversal number) now cycles.
  it('C: bulk cancel of ONE approved 2025 bill vs a single cancel holding that bill: no deadlock', async () => {
    const c = await fixture('BRK-C');
    const token = await seedRouteUser(c.fx, 'brk-c');
    const bill = await billWithVat(c, '2025-12-15', 'C1');
    await inTx(c.fx, () => approveSupplierInvoice(c.fx.companyId, bill, c.fx.userId));
    const before = await deadlocks(c);
    const p = await txn(c);
    let go!: () => void, locked!: () => void;
    const goP = new Promise<void>((res) => { go = res; });
    const lockedP = new Promise<void>((res) => { locked = res; });
    try {
      const pP = settle(p.run(async () => {
        await sql`SELECT id FROM supplier_invoices WHERE id = ${bill}::UUID FOR UPDATE`;
        locked();
        await goP;
        return cancelSupplierInvoice(c.fx.companyId, bill, c.fx.userId);
      }));
      await lockedP;
      const pR = settle(callRoute(c.fx, token, supplierBulk, { action: 'cancel', invoiceIds: [bill] }));
      await waitBlockedBy(c.fx.pool, p.pid);
      go();
      const [rp, rr] = [await pP, await pR];
      await new Promise((res) => setTimeout(res, 1500));
      const after = await deadlocks(c);
      out('C', { rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } });
      expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
    } finally {
      go();
      await p.abandon();
    }
  }, 90000);

  // SINGLE-YEAR BEHAVIOUR: cancelling a DRAFT 2025 bill posts no journal at all, yet now waits on (and 503s
  // behind) the 2026 journal key.
  it('D: bulk cancel of a DRAFT 2025 bill (no journal) with this year\'s key held 6 s: still answers 200', async () => {
    const c = await fixture('BRK-D');
    const token = await seedRouteUser(c.fx, 'brk-d');
    const bill = await billWithVat(c, '2025-12-15', 'D1');
    const year = new Date().getFullYear();
    const held = await holdKey(c.fx.pool, `${c.fx.companyId}:${year}`, 857);
    let res;
    const t0 = Date.now();
    try {
      res = await callRoute(c.fx, token, supplierBulk, { action: 'cancel', invoiceIds: [bill] });
    } finally {
      await held.open();
    }
    const st = (await sql`SELECT status FROM supplier_invoices WHERE id = ${bill}::UUID`) as Row[];
    out('D', { status: res.statusCode, ms: Date.now() - t0, body: res.body, bill: st[0] });
    expect(res.statusCode).toBe(200);
  }, 60000);

  // CLAIM (supplierInvoiceYearLocks): "Approve and post date each bill's journal on the bill's own date". A bulk
  // APPROVE opts in to the s16(3) late claim, whose companion is dated the first day after the VAT lock — a year
  // the up-front set {bill years} may not hold, taken after a later one.
  it('E: bulk approve [2024 bill in a filed VAT period, 2026 bill] vs an ascending 2025->2026 peer: no deadlock', async () => {
    const c = await fixture('BRK-E');
    await openYear(c.fx, 2024);
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, '1145', ${`Input VAT - late claims ${c.fx.tag}`}, 'asset',
        'vat_input_late_claim', 'debit', true, true)`;
    clearSystemAccountCache(c.fx.companyId);
    const token = await seedRouteUser(c.fx, 'brk-e');
    // The 2024 bill's id sorts FIRST, so the route walks 2024 (+ its 2025 companion) before 2026: before the
    // commit that order took 2024, 2025, 2026 ascending and could not cycle against the ascending peer.
    const b26 = await billWithVat(c, '2026-01-15', 'E26');
    let b24 = await billWithVat(c, '2024-12-15', 'E24');
    for (let i = 0; b24 > b26 && i < 40; i++) b24 = await billWithVat(c, '2024-12-15', `E24-${i}`);
    expect(b24 < b26).toBe(true);
    await lockPeriod(c.fx, '2024-11-01', '2025-02-28');
    const { rp, rr, before, after } = await ascendingPeerVs(c, () =>
      callRoute(c.fx, token, supplierBulk, { action: 'approve', invoiceIds: [b24, b26] }));
    const jes = (await sql`SELECT entry_number, entry_date::text AS d, source FROM gl_journal_entries
      WHERE company_id = ${c.fx.companyId}::UUID ORDER BY entry_number`) as Row[];
    out('E', { rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after }, jes });
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);

  // NOT COVERED (pre-existing): the AR take-on import posts one journal per invoice in FILE order, per-row
  // savepoints, one request transaction — the brk-docnum F3 shape the commit fixed elsewhere.
  it('F: AR take-on import [2026 invoice, 2025 invoice] vs an ascending peer: no deadlock', async () => {
    const c = await fixture('BRK-F');
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, '3900', ${`OBE ${c.fx.tag}`}, 'equity', 'opening_balance_equity', 'credit',
        true, true)`;
    clearSystemAccountCache(c.fx.companyId);
    const sess = (await sql`INSERT INTO migration_sessions (company_id, started_by)
      VALUES (${c.fx.companyId}::UUID, ${c.fx.userId}::UUID) RETURNING id`) as Row[];
    const cust = (await sql`SELECT name FROM customers WHERE id = ${c.fx.customerId}::UUID`) as Row[];
    const inv = (n: string, d: string) => ({ invoiceNumber: `BRKF-${n}-${c.fx.tag}`.slice(0, 50),
      customerName: String(cust[0]!.name), invoiceDate: d, dueDate: d, subtotal: 100, taxAmount: 0, totalAmount: 100 });
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => importARInvoices(c.fx.companyId,
      String(sess[0]!.id), [inv('26', '2026-01-05'), inv('25', '2025-12-20')], c.fx.userId));
    out('F', { rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } });
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);
  // The AP twin of F: importAPInvoices posts one take-on journal per bill in file order (migrationApService).
  it('F2: AP take-on import [2026 bill, 2025 bill] vs an ascending peer: no deadlock', async () => {
    const c = await fixture('BRK-F2');
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, '3900', ${`OBE ${c.fx.tag}`}, 'equity', 'opening_balance_equity', 'credit',
        true, true)`;
    clearSystemAccountCache(c.fx.companyId);
    const sess = (await sql`INSERT INTO migration_sessions (company_id, started_by)
      VALUES (${c.fx.companyId}::UUID, ${c.fx.userId}::UUID) RETURNING id`) as Row[];
    const sup = (await sql`SELECT name FROM suppliers WHERE id = ${c.fx.supplierId}::UUID`) as Row[];
    const bill = (n: string, d: string) => ({ invoiceNumber: `NRF2-${n}-${c.fx.tag}`.slice(0, 50),
      supplierName: String(sup[0]!.name), invoiceDate: d, dueDate: d, subtotal: 100, taxAmount: 0, totalAmount: 100 });
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => importAPInvoices(c.fx.companyId,
      String(sess[0]!.id), [bill('26', '2026-01-05'), bill('25', '2025-12-20')], c.fx.userId));
    out('F2', { rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } });
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);
});
