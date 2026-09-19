// tests/helpers/apBackfillGenerationFixture.ts
//
// A THIRD tenant, carrying one bank line through TWO generations of the
// allocate / cancel / re-allocate history that migration 679 exists for.
//
// It is a tenant of its own rather than another line in `apBackfillFixture`
// because this history is STATEFUL: generation one has to be minted, then
// cancelled and reversed, before generation two can be asked for. A line in the
// shared tenant would be swept into that tenant's batch, and cancelling its
// document afterwards would block that batch's rollback — which is a different
// test's subject.
//
// What it proves: a line whose FIRST backfilled document was cancelled and
// whose first journal was reversed, and which was then re-allocated onto a
// second journal, must be mintable AGAIN. The log's uniqueness floor is keyed
// on the bank line, so before migration 680 the second mint died on
// `uq_ap_pdb_created_line` — a 23505 raised INSIDE the data-modifying CTE,
// which aborts the WHOLE tenant's run over one line.
import { Pool } from 'pg';

export const CO3 = '00000000-0000-0000-0000-0000000bf500';
export const SUP3 = '00000000-0000-0000-0000-0000000bf501';
export const BANK3 = '00000000-0000-0000-0000-0000000bf502';
export const AP3 = '00000000-0000-0000-0000-0000000bf503';
export const USER3 = '00000000-0000-0000-0000-0000000bf504';
export const CO3_BILL = '00000000-0000-0000-0000-0000000bf505';
export const CO3_TX = '00000000-0000-0000-0000-0000000bf510';
/** The journal the FIRST allocation posted. */
export const CO3_JE1 = '00000000-0000-0000-0000-0000000bf520';
/** The journal the RE-allocation posted, after J1 was reversed. */
export const CO3_JE2 = '00000000-0000-0000-0000-0000000bf521';
export const CO3_AMOUNT = 4400;
export const CO3_NAME = 'Backfill Generation Supplier';

/** DR Accounts Payable / CR Bank for the full line amount, posted. */
async function postAllocationJournal(db: Pool, jeId: string, tag: string): Promise<string> {
  await db.query(
    `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, source, status, created_by, posted_by, posted_at)
     VALUES ($1,$2,$3,'2026-03-15',$4,'auto_supplier_payment','posted',$5,$5,NOW())`,
    [jeId, CO3, `BF3-JE-${tag}`, `Payment to ${CO3_NAME}`, USER3]);
  await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,$4,0,'AP leg')`, [CO3, jeId, AP3, CO3_AMOUNT]);
  const bank = await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,0,$4,'Bank leg') RETURNING id::TEXT`,
    [CO3, jeId, BANK3, CO3_AMOUNT]);
  return String(bank.rows[0]!.id);
}

export async function seedGeneration(db: Pool): Promise<void> {
  await db.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1,'AP Backfill Generations',true)
     ON CONFLICT (id) DO NOTHING`, [CO3]);
  await db.query(
    `INSERT INTO users (id, email, first_name) VALUES ($1::TEXT,'ap-backfill-3@fixture.local','AP Backfill Three')
     ON CONFLICT (id) DO NOTHING`, [USER3]);
  await db.query(
    `INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [SUP3, CO3, CO3_NAME]);
  await db.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,'BF1000','Fixture Bank Three','asset','bank','debit',true) ON CONFLICT (id) DO NOTHING`,
    [BANK3, CO3]);
  await db.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,'BF2110','Fixture Accounts Payable Three','liability','payable','credit',true) ON CONFLICT (id) DO NOTHING`,
    [AP3, CO3]);
  // The supplier needs ledger history or the line is refused before it is ever
  // classified `create`.
  await db.query(
    `INSERT INTO supplier_invoices (id, company_id, supplier_id, invoice_number, invoice_date, due_date, total_amount, amount_paid, status, created_by)
     VALUES ($1,$2,$3,'BF3-BILL-1','2026-02-01','2026-03-01',20000,0,'approved',$4) ON CONFLICT (id) DO NOTHING`,
    [CO3_BILL, CO3, SUP3, USER3]);

  const bankLine = await postAllocationJournal(db, CO3_JE1, 'GEN1');
  await db.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, allocation_type, allocated_entity_name, matched_journal_line_id)
     VALUES ($1,$2,$3,'2026-03-15',$4,'Fixture payment','allocated','supplier',$5,$6)`,
    [CO3_TX, CO3, BANK3, -CO3_AMOUNT, CO3_NAME, bankLine]);
}

/**
 * The second generation. Everything a user doing this by hand would do: cancel
 * the document, reverse the journal it carried, allocate the line again.
 */
export async function reallocateOntoSecondJournal(db: Pool): Promise<void> {
  await db.query(
    `UPDATE supplier_payments SET status = 'cancelled'
      WHERE company_id = $1::UUID AND status <> 'cancelled'`, [CO3]);
  await db.query(
    `UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = $1::UUID`, [CO3_JE1]);
  const rev = await db.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, posted_by, posted_at, reversal_of_id)
     VALUES ($1,'BF3-JER-GEN1','2026-03-16',$2,'auto_supplier_payment','posted',$3,$3,NOW(),$4) RETURNING id::TEXT`,
    [CO3, `Reversal of payment to ${CO3_NAME}`, USER3, CO3_JE1]);
  await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,0,$4,'AP leg reversed'), ($1,$2,$5,$4,0,'Bank leg reversed')`,
    [CO3, String(rev.rows[0]!.id), AP3, CO3_AMOUNT, BANK3]);

  const bankLine = await postAllocationJournal(db, CO3_JE2, 'GEN2');
  await db.query(
    `UPDATE bank_transactions SET matched_journal_line_id = $1::UUID WHERE id = $2::UUID`,
    [bankLine, CO3_TX]);
}
