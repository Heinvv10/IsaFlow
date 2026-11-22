/**
 * Migration 1018 against more real services as the PRODUCTION login (helpers/appLoginWorld): a bank allocation and its
 * reversal (the unwound journal links its contra), and the Sage migration commit of an AR invoice and an AP bill.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, seedFreeze, type Freeze, type Row } from './helpers/ledgerFreezeFixture';
import { seedBankTx } from './helpers/l1FifoFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

describeIfDisposable('ledger column immutability: bank allocation and the Sage commit as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => {
    if (world) await world.close();
    if (z) {
      const c = who.companyId;
      await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM customer_payments WHERE company_id = ${c}::UUID`.catch(() => undefined);
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${c}::UUID)`;
      await dropFreeze(z);
    }
  }, 120000);

  it('a bank line allocates to an account (journal posted, line allocated) and the allocation reverses (contra linked)', async () => {
    const { allocateTransaction } = await world.load(() => import('@/modules/accounting/services/bank/bankAllocationService'));
    const { reverseReconciledTransaction } = await world.load(() => import('@/modules/accounting/services/bank/bankReverseReconciled'));
    const tx = await seedBankTx(z.f.fx, { date: '2026-06-15', amount: -250, description: 'NS bank line' });
    const out = await world.run(who, () => allocateTransaction(who.companyId, tx, z.expense, who.userId));
    expect((await one(sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`)).status).toBe('allocated');
    await world.run(who, () => reverseReconciledTransaction(who.companyId, tx, who.userId));
    const contra = await one(sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${out.journalEntryId}::UUID`);
    expect(contra.id).toBeTruthy();
    expect((await one(sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`)).status).not.toBe('allocated');
  });

  it('the Sage commit posts and links a customer invoice and a supplier bill', async () => {
    const { commitARInvoice, commitAPInvoice } = await world.load(() => import('@/modules/admin/services/sageMigrationCommitService'));
    const ar = await world.run(who, () => commitARInvoice(who.companyId, who.userId, { invoiceNumber: 'NS-SAGE-AR', customerName: `CUS ${z.f.fx.tag}`,
      invoiceDate: '2026-06-20', subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 0 } as never));
    const ap = await world.run(who, () => commitAPInvoice(who.companyId, who.userId, { invoiceNumber: 'NS-SAGE-AP', supplierName: `SUP ${z.f.fx.tag}`,
      invoiceDate: '2026-06-21', subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 0 } as never));
    expect([ar.created, ap.created]).toEqual([true, true]);
    for (const [t, id] of [['customer_invoices', ar.invoiceId], ['supplier_invoices', ap.invoiceId]] as const) {
      const r = (await z.pool.query(`SELECT d.gl_journal_entry_id AS je, e.status FROM ${t} d JOIN gl_journal_entries e ON e.id = d.gl_journal_entry_id WHERE d.id = $1`, [id])).rows[0];
      expect(r?.status, t).toBe('posted');
    }
  });
});
