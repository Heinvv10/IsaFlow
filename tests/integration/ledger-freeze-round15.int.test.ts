/**
 * Migration 1018, round 15 (the round-14 breaker), through the real services as the production-shaped login
 * (helpers/appLoginWorld). Every case starts the ACCOUNT MERGE first: it holds the source and target FOR UPDATE, then
 * pauses in its link-key sweep on a decoy journal whose key a superuser holds. The request under test arrives during
 * that pause.
 *
 * L1: a document cancel, a credit-note cancel, a soft delete and its undo took the document row FOR UPDATE and only
 *     then (in the reversal's claim) waited on the account the merge held, while the merge's repointDocumentRows
 *     UPDATEs that document (it has an item on the merged account): 40P01. Now each takes the accounts of the
 *     document's journal (ledger_lock_accounts) before the document row, so it waits holding nothing.
 * L2: a reversal that waited on the merge built its contra from lines read before the claim, still on the merged-away
 *     account, and failed with InactiveAccountError ("reactivate the account"). It now re-reads them under the claim.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { document, dropFreeze, journal, seedFreeze, type Freeze, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { name?: string; message: string }) => `${e.name}: ${e.message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newAccount = async (name: string, type: 'expense' | 'revenue' = 'expense') => String((await one(sql`INSERT INTO gl_accounts
    (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, level)
  VALUES (${z.f.fx.companyId}::UUID, ${`69${randomUUID().slice(0, 4)}`}, ${name}, ${type},
    ${type === 'revenue' ? 'operating_revenue' : 'operating_expense'}, ${type === 'revenue' ? 'credit' : 'debit'}, true, 3)
  RETURNING id`)).id);
const waits = async () => ((await sql`SELECT query AS q FROM pg_stat_activity
  WHERE usename = ${world.login} AND wait_event_type = 'Lock'`) as Row[]).map((r) => String(r.q));
/** Whether another session can take `table`.`id` FOR UPDATE right now (NOWAIT), i.e. nobody holds it. */
async function rowFree(table: 'customer_invoices' | 'supplier_invoices', id: string): Promise<boolean> {
  const c = await z.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return false;
    throw err;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}

interface Race { merge: string; request: string; requestWaited: boolean; docFreeWhileWaiting: boolean | null; settledWhilePaused: boolean; target: string }

/** Start a merge of `src` into a fresh account, pause it after its account locks, run `request`, release the merge. */
async function mergeFirst(src: string, request: () => Promise<unknown>, doc?: { table: 'customer_invoices' | 'supplier_invoices'; id: string },
  targetType: 'expense' | 'revenue' = 'expense'): Promise<Race> {
  const { companyId, userId } = z.f.fx;
  const target = await newAccount('R15 target', targetType);
  const decoy = await journal(z, [[src, 1, 0], [z.ap, 0, 1]]); // the merge's sweep pauses on its key, after the accounts
  const who = { userId, companyId };
  const { mergeAccounts } = await world.load(() => import('@/modules/accounting/services/gl/accountMergeService'));
  const hold: PoolClient = await z.pool.connect();
  await hold.query('BEGIN');
  await hold.query('SELECT pg_advisory_xact_lock(public.ledger_link_key($1))', [decoy]);
  let requestDone = false;
  let merging: Promise<string> | undefined;
  let requesting: Promise<string> | undefined;
  let requestWaited = false;
  let docFreeWhileWaiting: boolean | null = null;
  let settledWhilePaused = false;
  try {
    merging = settle(world.run(who, () => mergeAccounts(companyId, src, target, userId)));
    await sleep(800);
    requesting = settle(world.run(who, request)).finally(() => { requestDone = true; });
    await sleep(1200);
    requestWaited = (await waits()).some((q) => !/pg_advisory_xact_lock|ledger_lock_key/.test(q));
    if (doc && requestWaited) docFreeWhileWaiting = await rowFree(doc.table, doc.id);
    settledWhilePaused = requestDone;
  } finally {
    await hold.query('ROLLBACK').catch(() => undefined); hold.release();
  }
  return { merge: await merging!, request: await requesting!, requestWaited, docFreeWhileWaiting, settledWhilePaused, target };
}

const expectBoth = (r: Race) => {
  expect(r.requestWaited, 'the request did not wait for the merge: the race was not staged').toBe(true);
  expect(r.request).toBe('ACCEPTED');
  expect(r.merge).toBe('ACCEPTED');
};
const contraAccounts = async (of: string) => ((await sql`SELECT DISTINCT l.gl_account_id AS a FROM gl_journal_entries e
  JOIN gl_journal_lines l ON l.journal_entry_id = e.id WHERE e.reversal_of_id = ${of}::UUID`) as Row[]).map((r) => String(r.a));
const invoiceItem = (inv: string, acct: string) => sql`INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, gl_account_id)
  VALUES (${inv}::UUID, 'r15', 1, 100, 100, ${acct}::UUID)`;

describeIfDisposable('ledger column immutability, round 15: the merge first, then a cancel, delete or reversal (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); world = await appLoginWorld(); }, 240000);
  afterAll(async () => {
    if (world) await world.close();
    if (z) {
      await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${z.f.fx.companyId}::UUID`;
      await sql`DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${z.f.fx.companyId}::UUID)`;
      await sql`DELETE FROM gl_account_merges WHERE company_id = ${z.f.fx.companyId}::UUID`;
      await dropFreeze(z);
    }
  }, 120000);

  it('L1 cancelCustomerInvoice of an invoice with an item on the merged account waits before the invoice row', async () => {
    const src = await newAccount('R15 ci src', 'revenue');
    const j = await journal(z, [[z.ar, 100, 0], [src, 0, 100]]);
    const inv = await document(z, 'customer_invoices', { link: j });
    await invoiceItem(inv, src);
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    const r = await mergeFirst(src, () => cancelCustomerInvoice(z.f.fx.companyId, inv, z.f.fx.userId), { table: 'customer_invoices', id: inv }, 'revenue');
    expectBoth(r);
    expect(r.docFreeWhileWaiting, 'the cancel held the invoice row while it waited on the account').toBe(true);
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${inv}::UUID`)).toEqual({ status: 'cancelled', je: null });
    expect(await contraAccounts(j)).toEqual(expect.arrayContaining([r.target]));
    expect(await contraAccounts(j)).not.toContain(src);
  }, 60000);

  it('L1 cancelSupplierInvoice of a bill with a line on the merged account waits before the bill row', async () => {
    const src = await newAccount('R15 si src');
    const j = await journal(z, [[src, 100, 0], [z.ap, 0, 100]]);
    const bill = await document(z, 'supplier_invoices', { link: j });
    await sql`INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, line_total, gl_account_id)
      VALUES (${bill}::UUID, 'r15', 1, 100, 100, ${src}::UUID)`;
    const { cancelSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const r = await mergeFirst(src, () => cancelSupplierInvoice(z.f.fx.companyId, bill, z.f.fx.userId), { table: 'supplier_invoices', id: bill });
    expectBoth(r);
    expect(r.docFreeWhileWaiting, 'the cancel held the bill row while it waited on the account').toBe(true);
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill}::UUID`)).toEqual({ status: 'cancelled', je: null });
    expect(await contraAccounts(j)).not.toContain(src);
  }, 60000);

  it('L1 the MCP cancel order (lockAndPlanSupplierInvoiceCancel, then cancelSupplierInvoice) waits before the bill row', async () => {
    const src = await newAccount('R15 mcp src');
    const j = await journal(z, [[src, 100, 0], [z.ap, 0, 100]]);
    const bill = await document(z, 'supplier_invoices', { link: j });
    await sql`INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, line_total, gl_account_id)
      VALUES (${bill}::UUID, 'r15', 1, 100, 100, ${src}::UUID)`;
    const { cancelSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const { lockAndPlanSupplierInvoiceCancel } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceCancelPlan'));
    const r = await mergeFirst(src, async () => {
      await lockAndPlanSupplierInvoiceCancel(z.f.fx.companyId, bill);
      return cancelSupplierInvoice(z.f.fx.companyId, bill, z.f.fx.userId);
    }, { table: 'supplier_invoices', id: bill });
    expectBoth(r);
    expect(r.docFreeWhileWaiting, 'the plan held the bill row while it waited on the account').toBe(true);
    expect(String((await one(sql`SELECT status FROM supplier_invoices WHERE id = ${bill}::UUID`)).status)).toBe('cancelled');
  }, 60000);

  it('L1 cancelCreditNote of a note crediting an invoice with an item on the merged account', async () => {
    const src = await newAccount('R15 cn src', 'revenue');
    const inv = await document(z, 'customer_invoices', { link: await journal(z, [[z.ar, 100, 0], [src, 0, 100]]) });
    await invoiceItem(inv, src);
    const cnJournal = await journal(z, [[src, 50, 0], [z.ar, 0, 50]]);
    const cn = await document(z, 'credit_notes', { link: cnJournal });
    await sql`UPDATE credit_notes SET customer_invoice_id = ${inv}::UUID WHERE id = ${cn}::UUID`;
    const { cancelCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteCancelService'));
    const r = await mergeFirst(src, () => cancelCreditNote(z.f.fx.companyId, cn, z.f.fx.userId, 'r15'), { table: 'customer_invoices', id: inv }, 'revenue');
    expectBoth(r);
    expect(r.docFreeWhileWaiting, 'the cancel held the credited invoice while it waited on the account').toBe(true);
    expect(String((await one(sql`SELECT status FROM credit_notes WHERE id = ${cn}::UUID`)).status)).toBe('cancelled');
    expect(await contraAccounts(cnJournal)).not.toContain(src);
  }, 60000);

  it('L1 softDelete of an invoice with an item on the merged account, then undoDelete, each racing a merge', async () => {
    const src = await newAccount('R15 sd src', 'revenue');
    const j = await journal(z, [[z.ar, 100, 0], [src, 0, 100]]);
    const inv = await document(z, 'customer_invoices', { link: j });
    await invoiceItem(inv, src);
    const { softDelete, undoDelete } = await world.load(() => import('@/modules/accounting/services/core/softDeleteService'));
    const del = await mergeFirst(src, () => softDelete(z.f.fx.companyId, 'customer_invoice', inv, z.f.fx.userId), { table: 'customer_invoices', id: inv }, 'revenue');
    expectBoth(del);
    expect(del.docFreeWhileWaiting, 'the delete held the invoice row while it waited on the account').toBe(true);
    expect((await one(sql`SELECT deleted_at IS NOT NULL AS d FROM customer_invoices WHERE id = ${inv}::UUID`)).d).toBe(true);
    const reversal = String((await one(sql`SELECT reversal_journal_entry_id AS r FROM soft_delete_journal_reversals
      WHERE company_id = ${z.f.fx.companyId}::UUID AND entity_id = ${inv}::UUID`)).r);
    // The undo: the delete's reversal now sits on the first merge's target; merge that account in turn.
    const undo = await mergeFirst(del.target, () => undoDelete(z.f.fx.companyId, 'customer_invoice', inv, z.f.fx.userId),
      { table: 'customer_invoices', id: inv }, 'revenue');
    expectBoth(undo);
    expect(undo.docFreeWhileWaiting, 'the undo held the invoice row while it waited on the account').toBe(true);
    expect((await one(sql`SELECT deleted_at IS NULL AS live FROM customer_invoices WHERE id = ${inv}::UUID`)).live).toBe(true);
    expect(await contraAccounts(reversal)).toEqual(expect.arrayContaining([undo.target]));
  }, 90000);

  it('L2 reverseJournalEntry that waited on the merge reverses the lines where the merge left them', async () => {
    const src = await newAccount('R15 L2 src');
    const x = await journal(z, [[src, 10, 0], [z.ap, 0, 10]]);
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const r = await mergeFirst(src, () => reverseJournalEntry(z.f.fx.companyId, x, z.f.fx.userId));
    expectBoth(r);
    expect((await one(sql`SELECT reversed_at IS NOT NULL AS c FROM gl_journal_entries WHERE id = ${x}::UUID`)).c).toBe(true);
    expect((await contraAccounts(x)).sort()).toEqual([r.target, z.ap].sort());
  }, 60000);

  it('L2 cancelCustomerInvoice (no item on the account) that waited on the merge cancels on the first try', async () => {
    const src = await newAccount('R15 L2 cancel src');
    const j = await journal(z, [[z.ar, 100, 0], [src, 0, 100]]);
    const inv = await document(z, 'customer_invoices', { link: j });
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    const r = await mergeFirst(src, () => cancelCustomerInvoice(z.f.fx.companyId, inv, z.f.fx.userId));
    expectBoth(r);
    expect(String((await one(sql`SELECT status FROM customer_invoices WHERE id = ${inv}::UUID`)).status)).toBe('cancelled');
    expect((await contraAccounts(j)).sort()).toEqual([r.target, z.ar].sort());
  }, 60000);

  it('over-strict: a cancel whose journal names neither merge account does not wait for the paused merge', async () => {
    const src = await newAccount('R15 os src', 'revenue');
    const j = await journal(z, [[z.ar, 100, 0], [z.revenue, 0, 100]]);
    const inv = await document(z, 'customer_invoices', { link: j });
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    const r = await mergeFirst(src, () => cancelCustomerInvoice(z.f.fx.companyId, inv, z.f.fx.userId), undefined, 'revenue');
    expect(r.settledWhilePaused, 'the cancel waited for a merge of accounts its journal does not use').toBe(true);
    expect(r.request).toBe('ACCEPTED');
    expect(r.merge).toBe('ACCEPTED');
  }, 60000);
});
