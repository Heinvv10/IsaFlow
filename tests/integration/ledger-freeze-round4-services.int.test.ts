/**
 * Migration 1018, review round 4, through the real services as the PRODUCTION login (helpers/appLoginWorld). L2: a
 * reversal at the 63-journal cap is refused with the service's own typed refusal, not a raw 23514. And the round-3
 * breaker's race census, kept as a test: an invoice cancel racing a reversal of its journal, an invoice cancel racing a
 * re-reversal of the chain, a credit-note cancel racing a reversal of its journal; never a deadlock, never a cancelled
 * document whose journal is in force.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, journal, negate, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const inForce = async (je: string) => (await one(sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`)).f;
const settle = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string; message?: string }) => `ERR ${e.code ?? ''}: ${String(e.message).slice(0, 80)}`);

describeIfDisposable('ledger column immutability, round 4: the real services as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => { if (world) await world.close(); if (z) await dropFreeze(z); }, 120000);

  it('the transaction is the production-shaped login -> app_user at READ COMMITTED and not a superuser', async () => {
    expect(await world.probe(who)).toEqual({ sessionUser: world.login, currentUser: 'app_user', superuser: 'off' });
    const { sql: appSql } = await world.load(() => import('@/lib/neon'));
    const [row] = (await world.run(who, () => appSql`SELECT current_setting('transaction_isolation') AS iso`)) as Row[];
    expect(row!.iso).toBe('read committed');
  });

  it('L2 a reversal that would make the chain 64 journals long is refused with JOURNAL_REVERSAL_CHAIN_FULL', async () => {
    const legs: Leg[] = [[z.expense, 10, 0], [z.ap, 0, 10]];
    // 63 journals linked as the superuser, each original stamped reversed (the shape reverseJournalEntry leaves).
    let head = await journal(z, legs);
    let cur = legs;
    for (let i = 1; i < 63; i++) {
      cur = negate(cur);
      const contra = await journal(z, cur);
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${head}::UUID WHERE id = ${contra}::UUID`;
      await sql`UPDATE gl_journal_entries SET reversed_at = now() WHERE id = ${head}::UUID`;
      head = contra;
    }
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const err = await world.run(who, () => reverseJournalEntry(z.f.fx.companyId, head, z.f.fx.userId)).then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err?.code).toBe('JOURNAL_REVERSAL_CHAIN_FULL');
    expect(err?.message).toMatch(/cannot be reversed: its reversal chain is full/);
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${head}::UUID`)).n).toBe(0);
  }, 120000);

  it('race census: cancels racing reversals never deadlock and never leave a cancelled document in force', async () => {
    const { createDraftCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCreateService'));
    const { approveCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceApprovalService'));
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const { createCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteService'));
    const { approveCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteApproveService'));
    const { cancelCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteCancelService'));
    const { fx } = z.f;
    const outcomes: string[] = [];
    let bad = 0;
    const invoice = async (price: number) => {
      const id = (await world.run(who, () => createDraftCustomerInvoice(fx.companyId, fx.userId, {
        clientId: fx.customerId, invoiceDate: '2026-06-10', taxRate: 15, items: [{ description: 'Work', unitPrice: price }] }))).id;
      await world.run(who, () => approveCustomerInvoice(fx.companyId, id, fx.userId));
      return { id, o: String((await one(sql`SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).je) };
    };
    const judge = async (table: 'customer_invoices' | 'credit_notes', id: string, je: string) => {
      const st = String((await one(table === 'credit_notes'
        ? sql`SELECT status FROM credit_notes WHERE id = ${id}::UUID`
        : sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`)).status);
      if (st === 'cancelled' && (await inForce(je))) bad++;
    };
    for (let i = 0; i < 6; i++) {
      const a = await invoice(100 + i);
      outcomes.push(...await Promise.all([settle(world.run(who, () => cancelCustomerInvoice(fx.companyId, a.id, fx.userId))),
        settle(world.run(who, () => reverseJournalEntry(fx.companyId, a.o, fx.userId)))]));
      await judge('customer_invoices', a.id, a.o);
      const b = await invoice(300 + i);
      const r = await world.run(who, () => reverseJournalEntry(fx.companyId, b.o, fx.userId));
      outcomes.push(...await Promise.all([settle(world.run(who, () => cancelCustomerInvoice(fx.companyId, b.id, fx.userId))),
        settle(world.run(who, () => reverseJournalEntry(fx.companyId, String(r.id), fx.userId)))]));
      await judge('customer_invoices', b.id, b.o);
      const cn = await world.run(who, () => createCreditNote(fx.companyId, { type: 'customer', clientId: fx.customerId, creditDate: '2026-06-20', subtotal: 50 + i, taxRate: 0 }, fx.userId));
      const je = String((await world.run(who, () => approveCreditNote(fx.companyId, cn.id, fx.userId))).glJournalEntryId);
      outcomes.push(...await Promise.all([settle(world.run(who, () => cancelCreditNote(fx.companyId, cn.id, fx.userId))),
        settle(world.run(who, () => reverseJournalEntry(fx.companyId, je, fx.userId)))]));
      await judge('credit_notes', cn.id, je);
    }
    expect(outcomes.filter((o) => o.includes('40P01'))).toEqual([]);
    expect(bad).toBe(0);
  }, 600000);
});
