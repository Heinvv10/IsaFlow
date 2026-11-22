/**
 * Migration 1018, round 10 (L4), through the real services as the PRODUCTION login (helpers/appLoginWorld): a legacy
 * journal whose lines carry vat_type '' reverses, its contra carrying '' (the same VAT box, the round-9 rule), and an
 * approved invoice holding such a journal can be cancelled.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, journal, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

describeIfDisposable("ledger column immutability, round 10: a '' VAT type reverses as the production login (migration 1018)", () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => { if (world) await world.close(); if (z) await dropFreeze(z); }, 120000);

  it("L4 a journal with vat_type '' reverses; the contra carries '' and the pair is an exact negation", async () => {
    const legs: Leg[] = [[z.expense, 40, 0], [z.ap, 0, 40]];
    const o = await journal(z, legs);
    await sql`UPDATE gl_journal_lines SET vat_type = '' WHERE journal_entry_id = ${o}::UUID`;
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const r = await world.run(who, () => reverseJournalEntry(z.f.fx.companyId, o, z.f.fx.userId));
    expect((await one(sql`SELECT count(*) FILTER (WHERE vat_type = '')::int AS e, count(*)::int AS n FROM gl_journal_lines WHERE journal_entry_id = ${r.id}::UUID`)))
      .toEqual({ e: 2, n: 2 });
    expect((await one(sql`SELECT public.gl_lines_are_negation(${r.id}::UUID, ${o}::UUID) AS n`)).n).toBe(true);
  });

  it("L4 an approved invoice whose journal carries vat_type '' is cancelled through the service", async () => {
    const { createDraftCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCreateService'));
    const { approveCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceApprovalService'));
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    const { fx } = z.f;
    const id = (await world.run(who, () => createDraftCustomerInvoice(fx.companyId, fx.userId, {
      clientId: fx.customerId, invoiceDate: '2026-06-10', taxRate: 15, items: [{ description: 'Work', unitPrice: 200 }] }))).id;
    await world.run(who, () => approveCustomerInvoice(fx.companyId, id, fx.userId));
    const o = String((await one(sql`SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).je);
    await sql`UPDATE gl_journal_lines SET vat_type = '' WHERE journal_entry_id = ${o}::UUID`; // the legacy shape, as the superuser
    await world.run(who, () => cancelCustomerInvoice(fx.companyId, id, fx.userId, { allowReversal: true }));
    expect((await one(sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`)).status).toBe('cancelled');
    expect((await one(sql`SELECT public.gl_journal_in_force(${o}::UUID) AS f`)).f).toBe(false);
  });
});
