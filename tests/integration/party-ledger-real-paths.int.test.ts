/**
 * party_ledger_check against journals the REAL posting paths share between
 * documents: processBatch (one journal on the batch row, none on the member
 * payments) and splitAllocateTransaction (one journal carried by one payment or
 * receipt per contact). Nothing about the shared journals is hand-seeded; only
 * the bills and invoices, which are given an ordinary posted journal so every
 * party here is CLEAN (statement == aged == GL). Any flag is a false positive.
 * (A split cannot be made ambiguous through the real path: it refuses a GL line on
 * the control account. The unattributable case is hand-seeded in
 * party-ledger-shared-journals.int.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { processBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { partyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerCheckService';
import type { PartyLedgerCheck, PartyType } from '@/modules/accounting/services/reconciliation/partyLedgerTypes';
import {
  dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const AS_AT = '2026-12-31';
let fx: Fixture;

async function accountId(code: string): Promise<string> {
  return ((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = ${code}`) as { id: string }[])[0]!.id;
}

/** An ordinary posted journal for a document: DR/CR control against revenue/expense, linked to the row. */
async function postDocument(table: 'supplier_invoices' | 'customer_invoices', id: string, amount: number, date: string) {
  const ap = table === 'supplier_invoices';
  const control = await accountId(ap ? '2100' : '1100');
  const other = await accountId(ap ? '6000' : '6000');
  const je = ((await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, source)
    VALUES (${fx.companyId}::UUID, ${'PLR-' + id.slice(0, 8)}, ${date}::date, 'plr doc', 'posted', ${fx.userId}::UUID, 'manual')
    RETURNING id`) as { id: string }[])[0]!.id;
  const [dr, cr] = ap ? [other, control] : [control, other];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES
            (${fx.companyId}::UUID, ${je}::UUID, ${dr}::UUID, ${amount}, 0),
            (${fx.companyId}::UUID, ${je}::UUID, ${cr}::UUID, 0, ${amount})`;
  if (ap) await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${id}::UUID`;
  else await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${id}::UUID`;
}

async function bill(supplierId: string, number: string, total: number): Promise<string> {
  const id = await seedBill(fx, { number, date: '2026-03-01', total, supplierId });
  await postDocument('supplier_invoices', id, total, '2026-03-01');
  return id;
}

const flags = (c: PartyLedgerCheck) => c.documents.flatMap((d) => d.flags.map((f) => `${d.kind}:${f.class}`));
const check = async (type: PartyType, id: string) => (await partyLedgerCheck(fx.companyId, type, id, AS_AT))!;
const attributions = (c: PartyLedgerCheck) => c.documents.filter((d) => d.kind === 'payment').map((d) => d.gl.attribution);

describeIfDb('party_ledger_check over the real shared-journal posting paths', () => {
  beforeAll(async () => { fx = await seedFixture('PLR', DATABASE_URL!); }, 60000);
  afterAll(async () => {
    await sql`UPDATE supplier_payment_batches SET gl_journal_entry_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM supplier_payment_batches WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 60000);

  it('processBatch: a two-supplier batch posts ONE journal; both suppliers are clean and attributed by batch total', async () => {
    const s1 = await seedSupplier(fx, 'BATCH1');
    const s2 = await seedSupplier(fx, 'BATCH2');
    const b1 = await bill(s1, 'BB1', 1000);
    const b2 = await bill(s2, 'BB2', 700);
    const batch = randomUUID();
    await sql`INSERT INTO supplier_payment_batches (id, company_id, batch_number, batch_date, total_amount, payment_count,
                payment_method, bank_account_id, status, created_by)
              VALUES (${batch}::UUID, ${fx.companyId}::UUID, ${'PLR-BAT-' + batch.slice(0, 8)}, '2026-03-15', 1700, 2, 'eft',
                      ${fx.bankAccountId}::UUID, 'approved', ${fx.userId}::UUID)`;
    for (const [supplier, invoice, amount] of [[s1, b1, 1000], [s2, b2, 700]] as const) {
      const pid = ((await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method,
                      status, batch_id, created_by)
                    VALUES (${fx.companyId}::UUID, ${supplier}::UUID, '2026-03-15', ${amount}, 'eft', 'approved', ${batch}::UUID, ${fx.userId}::UUID)
                    RETURNING id`) as { id: string }[])[0]!.id;
      await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pid}::UUID, ${invoice}::UUID, ${amount})`;
    }
    await inTx(fx, () => processBatch(fx.companyId, batch, fx.userId));

    const [j] = (await sql`SELECT gl_journal_entry_id AS id FROM supplier_payment_batches WHERE id = ${batch}::UUID`) as { id: string }[];
    const own = (await sql`SELECT COUNT(*)::int AS n FROM supplier_payments WHERE batch_id = ${batch}::UUID AND gl_journal_entry_id IS NOT NULL`) as { n: number }[];
    expect(j!.id).toBeTruthy();
    expect(own[0]!.n).toBe(0); // the premise: members carry NO journal of their own

    for (const [supplier, owed] of [[s1, 1000], [s2, 700]] as const) {
      const c = await check('supplier', supplier);
      expect(c.totals).toMatchObject({ statementBalance: 0, agedNet: 0, glControlNet: 0, statementMinusGl: 0, unexplainedResidual: 0 });
      expect(flags(c)).toEqual([]);
      expect(attributions(c)).toEqual(['batch_total']);
      expect(c.documents.find((d) => d.kind === 'payment')!.gl.controlNet).toBe(-owed);
      expect(c.invariants.filter((i) => !i.holds)).toEqual([]);
      // The batch journal is claimed by its members: it is not a journal "no document" carries.
      expect(c.unattributed.count).toBe(0);
    }
  }, 120000);

  it('processBatch: a one-member batch owns its journal outright', async () => {
    const s = await seedSupplier(fx, 'BATCH3');
    const inv = await bill(s, 'BB3', 400);
    const batch = randomUUID();
    await sql`INSERT INTO supplier_payment_batches (id, company_id, batch_number, batch_date, total_amount, payment_count,
                payment_method, bank_account_id, status, created_by)
              VALUES (${batch}::UUID, ${fx.companyId}::UUID, ${'PLR-BAT-' + batch.slice(0, 8)}, '2026-03-16', 400, 1, 'eft',
                      ${fx.bankAccountId}::UUID, 'approved', ${fx.userId}::UUID)`;
    const pid = ((await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, status, batch_id, created_by)
                VALUES (${fx.companyId}::UUID, ${s}::UUID, '2026-03-16', 400, 'eft', 'approved', ${batch}::UUID, ${fx.userId}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pid}::UUID, ${inv}::UUID, 400)`;
    await inTx(fx, () => processBatch(fx.companyId, batch, fx.userId));
    const c = await check('supplier', s);
    expect(flags(c)).toEqual([]);
    expect(attributions(c)).toEqual(['own']);
    expect(c.totals.glControlNet).toBe(0);
  }, 120000);

  it('splitAllocateTransaction: one bank line to two suppliers -> each supplier counts only its own leg', async () => {
    const frik = await seedSupplier(fx, 'FRIK');
    const southern = await seedSupplier(fx, 'SOUTHERN');
    await bill(frik, 'SB1', 800);
    await bill(southern, 'SB2', 1159.48);
    const tx = await seedBankTx(fx, { date: '2026-10-07', amount: -1959.48, description: 'two suppliers' });
    await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, [
      { contactType: 'supplier', contactId: frik, amount: 800 },
      { contactType: 'supplier', contactId: southern, amount: 1159.48 },
    ], fx.userId));
    for (const [supplier, owed] of [[frik, 800], [southern, 1159.48]] as const) {
      const c = await check('supplier', supplier);
      expect(c.totals).toMatchObject({ statementBalance: 0, glControlNet: 0, statementMinusGl: 0, unexplainedResidual: 0 });
      expect(flags(c)).toEqual([]);
      expect(attributions(c)).toEqual(['line_match']);
      expect(c.documents.find((d) => d.kind === 'payment')!.gl.controlNet).toBe(-owed);
      expect(c.documents.find((d) => d.kind === 'payment')!.gl.sharedWith).toHaveLength(1);
    }
  }, 120000);

  it('splitAllocateTransaction: two receipts to one customer share a journal and are each attributed', async () => {
    const inv = await seedInvoice(fx, { number: 'SR-INV', date: '2026-03-01', total: 1000 });
    await postDocument('customer_invoices', inv, 1000, '2026-03-01');
    const tx = await seedBankTx(fx, { date: '2026-10-11', amount: 1000, description: 'two receipts' });
    await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, [
      { contactType: 'customer', contactId: fx.customerId, amount: 700 },
      { contactType: 'customer', contactId: fx.customerId, amount: 300 },
    ], fx.userId));
    const c = await check('customer', fx.customerId);
    expect(c.totals).toMatchObject({ statementBalance: 0, glControlNet: 0, statementMinusGl: 0, unexplainedResidual: 0 });
    expect(flags(c)).toEqual([]);
    expect(c.documents.filter((d) => d.kind === 'payment').map((d) => [d.gl.attribution, d.gl.controlNet])
      .sort((x, y) => (x[1] as number) - (y[1] as number)))
      .toEqual([['line_match', -700], ['line_match', -300]]);
  }, 120000);
});
