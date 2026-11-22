/**
 * Migration 1018 against the real services as the PRODUCTION login (helpers/appLoginWorld: session_user the fixture's isaflow_app-shaped login, a
 * request transaction as app_user, never the fixture superuser): each ledger writer once. A refusal here is a rule that
 * is wrong or a writer that must change. Covers the document approve/cancel services, journal reversal (the service and
 * the MCP tool), the recurring journal run and a re-reversal that re-instates a document's journal.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, seedFreeze, type Freeze, type Row } from './helpers/ledgerFreezeFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const contraOf = async (je: string) => one(sql`SELECT id, status FROM gl_journal_entries WHERE reversal_of_id = ${je}::UUID`);

describeIfDisposable('ledger column immutability: the real services as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => { if (world) await world.close(); if (z) await dropFreeze(z); }, 120000);

  it('the transaction is the production-shaped login -> app_user and not a superuser', async () => {
    expect(await world.probe(who)).toEqual({ sessionUser: world.login, currentUser: 'app_user', superuser: 'off' });
  });

  it('a customer invoice approves (posts and links), and cancels (reverses, unlinks, cancels)', async () => {
    const { createDraftCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCreateService'));
    const { approveCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceApprovalService'));
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    const { fx } = z.f;
    const id = (await world.run(who, () => createDraftCustomerInvoice(fx.companyId, fx.userId, {
      clientId: fx.customerId, invoiceDate: '2026-06-10', taxRate: 15, items: [{ description: 'Work', unitPrice: 200 }] }))).id;
    await world.run(who, () => approveCustomerInvoice(fx.companyId, id, fx.userId));
    const approved = await one(sql`SELECT status, gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`);
    expect(approved.status).toBe('approved');
    expect(approved.je).not.toBeNull();
    await world.run(who, () => cancelCustomerInvoice(fx.companyId, id, fx.userId, { allowReversal: true }));
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID`)).toMatchObject({ status: 'cancelled', je: null });
    expect((await contraOf(String(approved.je))).status).toBe('posted');
  });

  it('a supplier bill approves and cancels', async () => {
    const { createSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceService'));
    const { approveSupplierInvoice, cancelSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const { fx } = z.f;
    const bill = await world.run(who, () => createSupplierInvoice(fx.companyId, { supplierId: fx.supplierId, invoiceNumber: 'NS-B1',
      invoiceDate: '2026-06-10', items: [{ description: 'Line', quantity: 1, unitPrice: 300, glAccountId: z.expense }] }, fx.userId));
    await world.run(who, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId));
    const approved = await one(sql`SELECT status, gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`);
    expect(approved.je).not.toBeNull();
    await world.run(who, () => cancelSupplierInvoice(fx.companyId, bill.id, fx.userId));
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).toMatchObject({ status: 'cancelled', je: null });
  });

  it('a credit note approves and cancels (its journal reversed, its link kept)', async () => {
    const { createCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteService'));
    const { approveCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteApproveService'));
    const { cancelCreditNote } = await world.load(() => import('@/modules/accounting/services/ar/creditNoteCancelService'));
    const { fx } = z.f;
    const cn = await world.run(who, () => createCreditNote(fx.companyId, { type: 'customer', clientId: fx.customerId,
      creditDate: '2026-06-20', subtotal: 50, taxRate: 0 }, fx.userId));
    const je = String((await world.run(who, () => approveCreditNote(fx.companyId, cn.id, fx.userId))).glJournalEntryId);
    await world.run(who, () => cancelCreditNote(fx.companyId, cn.id, fx.userId));
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM credit_notes WHERE id = ${cn.id}::UUID`)).toMatchObject({ status: 'cancelled', je });
    expect((await contraOf(je)).status).toBe('posted');
  });

  it('a manual journal posts and reverses through the service, and the contra of a contra re-instates it', async () => {
    const { createJournalEntry, postJournalEntry, reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const { fx } = z.f;
    const je = await world.run(who, async () => {
      const made = await createJournalEntry(fx.companyId, { entryDate: '2026-06-12', description: 'NS manual', source: 'manual',
        lines: [{ glAccountId: z.expense, debit: 40, credit: 0 }, { glAccountId: z.ap, debit: 0, credit: 40 }] }, fx.userId);
      await postJournalEntry(fx.companyId, made.id, fx.userId);
      return made.id;
    });
    const r1 = (await world.run(who, () => reverseJournalEntry(fx.companyId, je, fx.userId))).id;
    const r2 = (await world.run(who, () => reverseJournalEntry(fx.companyId, r1, fx.userId))).id;
    expect(String((await one(sql`SELECT reversal_of_id FROM gl_journal_entries WHERE id = ${r2}::UUID`)).reversal_of_id)).toBe(r1);
  });

  it('the MCP reverse_journal_entry tool reverses a posted journal', async () => {
    const { createJournalEntry, postJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const { reverseJournalEntryTool } = await world.load(() => import('@/lib/mcp/tools/writeJournalReverse'));
    const { fx } = z.f;
    const je = await world.run(who, async () => {
      const made = await createJournalEntry(fx.companyId, { entryDate: '2026-06-13', description: 'NS mcp', source: 'manual',
        lines: [{ glAccountId: z.expense, debit: 15, credit: 0 }, { glAccountId: z.ap, debit: 0, credit: 15 }] }, fx.userId);
      await postJournalEntry(fx.companyId, made.id, fx.userId);
      return made.id;
    });
    const ctx = { userId: fx.userId, companyId: fx.companyId, scopes: ['write:journals', 'write:post'], companyRole: 'owner', tokenJti: 'ns', oauthAppId: null };
    const reply = await world.run(who, () => reverseJournalEntryTool.handler({ journal_entry_id: je, idempotency_key: crypto.randomUUID() }, ctx as never));
    expect(JSON.stringify(reply)).not.toMatch(/"isError":true/);
    expect((await contraOf(je)).status).toBe('posted');
  });

  it('a recurring journal template runs (draft, post, advance)', async () => {
    const { createRecurringJournal, runRecurringJournal } = await world.load(() => import('@/modules/accounting/services/gl/recurringJournalService'));
    const { fx } = z.f;
    const tpl = await world.run(who, () => createRecurringJournal(fx.companyId, { templateName: 'NS rent', frequency: 'monthly',
      nextRunDate: '2026-06-01', lines: [{ glAccountId: z.expense, debit: 25, credit: 0, description: 'rent' },
        { glAccountId: z.ap, debit: 0, credit: 25, description: 'rent' }] } as never, fx.userId));
    const run = await world.run(who, () => runRecurringJournal(fx.companyId, tpl.id, fx.userId));
    expect((await one(sql`SELECT status FROM gl_journal_entries WHERE id = ${run.journalId}::UUID`)).status).toBe('posted');
  });
});
