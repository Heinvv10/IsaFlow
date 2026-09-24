/**
 * The SAGE AP COMMIT posts a migrated bill with a raw status UPDATE, bypassing
 * postJournalEntry; a bill carrying input VAT dated in a filed period is
 * refused before anything is written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { commitAPInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;

async function lockMayJune(): Promise<void> {
  await sql`
    INSERT INTO vat_period_locks
      (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
    VALUES (${fx.companyId}::UUID, '2026-05-01', '2026-06-30', 0, 0, 0, '2026-06-30', ${fx.userId})`;
}
const unlockAll = () => sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;

describeIfDb('Sage AP commit against a locked VAT period', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test commits migrated bills.');
    fx = await seedFixture('VLO', DATABASE_URL!);
    clearSystemAccountCache(fx.companyId);
  }, 120000);

  afterAll(async () => {
    const c = fx.companyId;
    clearSystemAccountCache(c);
    await unlockAll();
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses the Sage AP commit of a bill with input VAT dated in a locked period, writing nothing', async () => {
    const supplierName = String(((await sql`SELECT name FROM suppliers WHERE id = ${fx.supplierId}::UUID`) as Row[])[0]!.name);
    await lockMayJune();
    try {
      const err = await inTx(fx, () => commitAPInvoice(fx.companyId, fx.userId, {
        invoiceNumber: `SAGE-1-${fx.tag}`, supplierName, invoiceDate: '2026-06-05',
        subtotal: 100, taxAmount: 15, totalAmount: 115,
      })).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(VatPeriodLockedError);
      const rows = (await sql`
        SELECT 1 FROM supplier_invoices WHERE company_id = ${fx.companyId}::UUID
          AND invoice_number = ${`SAGE-1-${fx.tag}`}`) as Row[];
      expect(rows).toHaveLength(0);

      // Outside the lock the same commit posts.
      const ok = await inTx(fx, () => commitAPInvoice(fx.companyId, fx.userId, {
        invoiceNumber: `SAGE-2-${fx.tag}`, supplierName, invoiceDate: '2026-07-05',
        subtotal: 100, taxAmount: 15, totalAmount: 115,
      }));
      expect(ok.created).toBe(true);
    } finally {
      await unlockAll();
    }
  });
});
