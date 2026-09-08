// tests/helpers/apBackfillFixture.ts
//
// The fixture both AP payment-document backfill suites run against
// (`ap-payment-document-backfill-classify` and `-run`). It is one tenant
// carrying one bank line per classification outcome, plus a SECOND tenant
// carrying its own qualifying line — because a run scoped to one company must
// be provable to leave the other alone, and one company is not the platform.
//
// Every id is a literal so a failing assertion names one row rather than a
// total.
import { Pool } from 'pg';

export const CO = '00000000-0000-0000-0000-0000000bf000';
export const SUP = '00000000-0000-0000-0000-0000000bf001';
// Two live suppliers sharing one name: `bank_transactions` carries no supplier
// id, only `allocated_entity_name`, so this is the shape that must refuse.
export const TWIN_A = '00000000-0000-0000-0000-0000000bf002';
export const TWIN_B = '00000000-0000-0000-0000-0000000bf003';
export const BANK = '00000000-0000-0000-0000-0000000bf004';
export const AP = '00000000-0000-0000-0000-0000000bf005';
export const OTHER = '00000000-0000-0000-0000-0000000bf006';
export const BILL = '00000000-0000-0000-0000-0000000bf007';
export const USER = '00000000-0000-0000-0000-0000000bf008';

// The second tenant. It uses the SAME supplier trading name as the first,
// deliberately: name is how this backfill resolves a supplier, so two tenants
// sharing one name is the shape that crosses the streams if the scoping is
// wrong anywhere.
export const CO2 = '00000000-0000-0000-0000-0000000bf300';
export const SUP2 = '00000000-0000-0000-0000-0000000bf301';
export const BANK2 = '00000000-0000-0000-0000-0000000bf302';
export const AP2 = '00000000-0000-0000-0000-0000000bf303';
export const USER2 = '00000000-0000-0000-0000-0000000bf304';
export const CO2_TX = '00000000-0000-0000-0000-0000000bf310';
export const CO2_JE = '00000000-0000-0000-0000-0000000bf320';
export const CO2_BILL = '00000000-0000-0000-0000-0000000bf305';
export const CO2_AMOUNT = 3300;

// A supplier with no bill and no other payment in this tenant — the shape a
// rename-and-reuse impostor has. `allocated_entity_name` is a frozen string
// with no id behind it, so "exactly one match" is not "the right row"; this is
// the one signal that separates the two, and it refuses rather than mints.
export const NOHIST = '00000000-0000-0000-0000-0000000bf009';
export const NOHIST_NAME = 'Backfill Fixture Stranger';

export const SUP_NAME = 'Backfill Fixture Supplier';
export const TWIN_NAME = 'Backfill Fixture Twin';

/** An existing document found by the journal it carries, and nothing else. */
export const DOC_BY_JOURNAL = '00000000-0000-0000-0000-0000000bf101';
/** An existing document found by the bank line in its `reference`, only. */
export const DOC_BY_REFERENCE = '00000000-0000-0000-0000-0000000bf10e';

/** The shared-journal pair: two bank lines, one journal between them. */
export const SHARED_A = '00000000-0000-0000-0000-0000000bf10b';
export const SHARED_B = '00000000-0000-0000-0000-0000000bf10c';

/** bank tx id -> what the view must say about it, and the line amount. */
export const CASES: Array<[string, string, number]> = [
  ['00000000-0000-0000-0000-0000000bf100', 'create', 1000],
  // TWO of them, and the split is the point. The existing document is found
  // EITHER by the journal it carries OR by the bank line in its `reference`,
  // and a fixture that sets both makes either half of that OR deletable
  // without a test noticing. `DOC_BY_JOURNAL` carries only the journal;
  // `DOC_BY_REFERENCE` carries only the reference.
  [DOC_BY_JOURNAL, 'already_has_document', 1100],
  [DOC_BY_REFERENCE, 'already_has_document', 1150],
  ['00000000-0000-0000-0000-0000000bf102', 'no_journal', 1200],
  ['00000000-0000-0000-0000-0000000bf103', 'journal_not_posted', 1300],
  ['00000000-0000-0000-0000-0000000bf104', 'journal_reversed', 1400],
  ['00000000-0000-0000-0000-0000000bf105', 'journal_unbalanced', 1500],
  ['00000000-0000-0000-0000-0000000bf106', 'ap_debit_mismatch', 1600],
  ['00000000-0000-0000-0000-0000000bf107', 'bank_credit_mismatch', 1700],
  ['00000000-0000-0000-0000-0000000bf108', 'supplier_unresolved', 1800],
  ['00000000-0000-0000-0000-0000000bf109', 'supplier_ambiguous', 1900],
  // Somebody cancelled the payment and the journal was never reversed. The
  // cash is on the control account behind a cancelled document — reported,
  // never replaced: minting a new one overrides the cancellation.
  ['00000000-0000-0000-0000-0000000bf10a', 'document_cancelled_journal_stands', 2000],
  // Two bank lines pointing at ONE journal, the shape both legs of a bank
  // transfer already have in production. Minting a document for one would make
  // the other read as finished forever, so both are named instead.
  [SHARED_A, 'journal_shared_by_bank_lines', 2100],
  [SHARED_B, 'journal_shared_by_bank_lines', 2100],
  ['00000000-0000-0000-0000-0000000bf10d', 'supplier_has_no_ledger_history', 2200],
];
export const NOHIST_TX = '00000000-0000-0000-0000-0000000bf10d';
export const CREATE_TX = CASES[0]![0];
/** Money IN against a supplier -- a refund. Must not be classified at all. */
export const REFUND_TX = '00000000-0000-0000-0000-0000000bf110';

/** Deterministic journal id per bank transaction, so assertions can name one. */
export function journalFor(txId: string): string {
  // SHARED_B carries no journal of its own: it points at SHARED_A's bank leg,
  // which is exactly how a transfer's second leg reaches the same entry.
  if (txId === SHARED_B) return journalFor(SHARED_A);
  return txId.replace('0bf1', '0bf2');
}

/** Everything the backfill is forbidden to change, for one company. */
export async function ledgerShape(
  db: Pool, company: string = CO, ap: string = AP,
): Promise<Record<string, number>> {
  const r = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id = $1::UUID)          AS entries,
       (SELECT COUNT(*) FROM gl_journal_lines   WHERE company_id = $1::UUID)          AS lines,
       (SELECT COALESCE(SUM(debit - credit), 0) FROM gl_journal_lines
         WHERE company_id = $1::UUID AND gl_account_id = $2::UUID)                    AS ap_movement,
       (SELECT COALESCE(SUM(amount_paid), 0) FROM supplier_invoices
         WHERE company_id = $1::UUID)                                                 AS amount_paid,
       (SELECT COUNT(*) FROM supplier_payments WHERE company_id = $1::UUID)           AS payments,
       (SELECT COUNT(*) FROM payment_allocations pa
          JOIN supplier_payments sp ON sp.id = pa.payment_id
         WHERE sp.company_id = $1::UUID)                                              AS allocations`,
    [company, ap],
  );
  const row = r.rows[0]!;
  return {
    entries: Number(row.entries),
    lines: Number(row.lines),
    apMovement: Number(row.ap_movement),
    amountPaid: Number(row.amount_paid),
    payments: Number(row.payments),
    allocations: Number(row.allocations),
  };
}

export async function createdPaymentId(db: Pool, batch: string): Promise<string> {
  const r = await db.query(
    `SELECT supplier_payment_id::TEXT AS id FROM ap_payment_document_backfill
      WHERE batch_id = $1::UUID AND outcome = 'created' AND rolled_back_at IS NULL`,
    [batch],
  );
  return String(r.rows[0]!.id);
}

export async function seed(db: Pool): Promise<void> {
  await db.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1,'AP Backfill Fixture',true)
     ON CONFLICT (id) DO NOTHING`, [CO]);
  await db.query(
    `INSERT INTO users (id, email, first_name) VALUES ($1::TEXT,'ap-backfill@fixture.local','AP Backfill')
     ON CONFLICT (id) DO NOTHING`, [USER]);
  for (const [id, name] of [
    [SUP, SUP_NAME], [TWIN_A, TWIN_NAME], [TWIN_B, TWIN_NAME], [NOHIST, NOHIST_NAME],
  ] as const) {
    await db.query(
      `INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [id, CO, name]);
  }
  await db.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,'BF1000','Fixture Bank','asset','bank','debit',true) ON CONFLICT (id) DO NOTHING`,
    [BANK, CO]);
  await db.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,'BF2110','Fixture Accounts Payable','liability','payable','credit',true) ON CONFLICT (id) DO NOTHING`,
    [AP, CO]);
  await db.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,'BF5000','Fixture Expense','expense','operating_expense','debit',true) ON CONFLICT (id) DO NOTHING`,
    [OTHER, CO]);
  await db.query(
    `INSERT INTO supplier_invoices (id, company_id, supplier_id, invoice_number, invoice_date, due_date, total_amount, amount_paid, status, created_by)
     VALUES ($1,$2,$3,'BF-BILL-1','2026-02-01','2026-03-01',5000,0,'approved',$4) ON CONFLICT (id) DO NOTHING`,
    [BILL, CO, SUP, USER]);

  for (const [txId, outcome, amount] of CASES) {
    const jeId = journalFor(txId);
    // SHARED_B is the second leg: it reuses SHARED_A's journal and bank line
    // rather than posting its own, which is how a transfer's two sides both
    // reach one entry.
    const needsJournal = outcome !== 'no_journal' && txId !== SHARED_B;
    // `posted` unless the case is about a journal that is not.
    const status = outcome === 'journal_not_posted' ? 'draft' : 'posted';
    // The AP leg. `ap_debit_mismatch` debits an expense account for part of it,
    // the shape a VAT-split allocation leaves behind.
    const apDebit = outcome === 'ap_debit_mismatch' ? amount - 100 : amount;
    // `bank_credit_mismatch` credits a DIFFERENT account: the journal
    // `matched_journal_line_id` reaches is not this line's own.
    const creditAccount = outcome === 'bank_credit_mismatch' ? OTHER : BANK;
    // `journal_unbalanced` is INSERTed already posted: trg_gl_je_balanced is
    // BEFORE UPDATE, so a direct insert of an unbalanced posted entry is
    // exactly how one gets into these books.
    const bankCredit = outcome === 'journal_unbalanced' ? amount - 50 : amount;
    const entityName = outcome === 'supplier_unresolved'
      ? 'No Such Supplier At All'
      : outcome === 'supplier_ambiguous' ? TWIN_NAME
      : outcome === 'supplier_has_no_ledger_history' ? NOHIST_NAME : SUP_NAME;

    let lineId: string | null = null;
    if (needsJournal) {
      await db.query(
        `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, source, status, created_by, posted_by, posted_at, reversed_at)
         VALUES ($1,$2,$3,'2026-03-15',$4,'auto_supplier_payment',$5,$6,$6,NOW(),$7)`,
        [jeId, CO, `BF-JE-${txId.slice(-4)}`, `Payment to ${entityName}`, status, USER,
         outcome === 'journal_reversed' ? new Date() : null],
      );
      await db.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
         VALUES ($1,$2,$3,$4,0,'AP leg')`, [CO, jeId, AP, apDebit]);
      if (apDebit !== amount) {
        await db.query(
          `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
           VALUES ($1,$2,$3,$4,0,'VAT-ish leg')`, [CO, jeId, OTHER, amount - apDebit]);
      }
      const bankLine = await db.query(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
         VALUES ($1,$2,$3,0,$4,'Bank leg') RETURNING id::TEXT`,
        [CO, jeId, creditAccount, bankCredit]);
      lineId = String(bankLine.rows[0]!.id);
    } else if (txId === SHARED_B) {
      const existing = await db.query(
        `SELECT id::TEXT FROM gl_journal_lines
          WHERE journal_entry_id = $1::UUID AND gl_account_id = $2::UUID`,
        [jeId, BANK]);
      lineId = String(existing.rows[0]!.id);
    }

    await db.query(
      `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, allocation_type, allocated_entity_name, matched_journal_line_id)
       VALUES ($1,$2,$3,'2026-03-15',$4,'Fixture payment','allocated','supplier',$5,$6)`,
      [txId, CO, BANK, -amount, entityName, lineId],
    );

    if (outcome === 'already_has_document' || outcome === 'document_cancelled_journal_stands') {
      // Exactly ONE of the two links, so neither half of the classifier's OR
      // can be deleted without a test going red.
      const byReferenceOnly = txId === DOC_BY_REFERENCE;
      await db.query(
        `INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, bank_account_id, reference, status, gl_journal_entry_id, created_by)
         VALUES ($1,$2,'2026-03-15',$3,'eft',$4,$5,$8,$6,$7)`,
        [CO, SUP, amount, BANK,
         byReferenceOnly ? txId : null,
         byReferenceOnly ? null : jeId,
         USER,
         outcome === 'already_has_document' ? 'processed' : 'cancelled'],
      );
    }
  }

  // ── The second tenant ─────────────────────────────────────────────────────
  //
  // One qualifying line of its own, against a supplier with the SAME NAME as
  // the first tenant's. A run scoped to CO must create nothing here, and a run
  // scoped to CO2 must resolve SUP2 and never SUP.
  await db.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1,'AP Backfill Fixture Two',true)
     ON CONFLICT (id) DO NOTHING`, [CO2]);
  await db.query(
    `INSERT INTO users (id, email, first_name) VALUES ($1::TEXT,'ap-backfill-2@fixture.local','AP Backfill Two')
     ON CONFLICT (id) DO NOTHING`, [USER2]);
  await db.query(
    `INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [SUP2, CO2, SUP_NAME]);
  await db.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,'BF1000','Fixture Bank Two','asset','bank','debit',true) ON CONFLICT (id) DO NOTHING`,
    [BANK2, CO2]);
  await db.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,'BF2110','Fixture Accounts Payable Two','liability','payable','credit',true) ON CONFLICT (id) DO NOTHING`,
    [AP2, CO2]);
  await db.query(
    `INSERT INTO supplier_invoices (id, company_id, supplier_id, invoice_number, invoice_date, due_date, total_amount, amount_paid, status, created_by)
     VALUES ($1,$2,$3,'BF2-BILL-1','2026-02-01','2026-03-01',9000,0,'approved',$4) ON CONFLICT (id) DO NOTHING`,
    [CO2_BILL, CO2, SUP2, USER2]);
  await db.query(
    `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, source, status, created_by, posted_by, posted_at)
     VALUES ($1,$2,'BF2-JE-1','2026-03-15',$3,'auto_supplier_payment','posted',$4,$4,NOW())`,
    [CO2_JE, CO2, `Payment to ${SUP_NAME}`, USER2]);
  await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,$4,0,'AP leg')`, [CO2, CO2_JE, AP2, CO2_AMOUNT]);
  const co2Bank = await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,0,$4,'Bank leg') RETURNING id::TEXT`,
    [CO2, CO2_JE, BANK2, CO2_AMOUNT]);
  await db.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, allocation_type, allocated_entity_name, matched_journal_line_id)
     VALUES ($1,$2,$3,'2026-03-15',$4,'Fixture payment','allocated','supplier',$5,$6)`,
    [CO2_TX, CO2, BANK2, -CO2_AMOUNT, SUP_NAME, String(co2Bank.rows[0]!.id)]);

  // The refund: money IN against the same supplier, allocated the same way.
  await db.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, allocation_type, allocated_entity_name)
     VALUES ($1,$2,$3,'2026-03-16',2500,'Fixture refund','allocated','supplier',$4)`,
    [REFUND_TX, CO, BANK, SUP_NAME],
  );
}

export async function cleanup(db: Pool): Promise<void> {
  for (const co of [CO, CO2]) await cleanupCompany(db, co);
  await db.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[USER, USER2]]);
}

async function cleanupCompany(db: Pool, CO: string): Promise<void> {
  await db.query('DELETE FROM ap_payment_document_backfill WHERE company_id = $1::UUID', [CO]);
  await db.query(
    `DELETE FROM payment_allocations WHERE payment_id IN
       (SELECT id FROM supplier_payments WHERE company_id = $1::UUID)`, [CO]);
  await db.query(
    `DELETE FROM supplier_payment_allocations WHERE payment_id IN
       (SELECT id FROM supplier_payments WHERE company_id = $1::UUID)`, [CO]);
  await db.query('DELETE FROM supplier_payments WHERE company_id = $1::UUID', [CO]);
  await db.query('DELETE FROM bank_transactions WHERE company_id = $1::UUID', [CO]);
  await db.query('DELETE FROM supplier_invoices WHERE company_id = $1::UUID', [CO]);
  await db.query('DELETE FROM gl_journal_lines WHERE company_id = $1::UUID', [CO]);
  await db.query('DELETE FROM gl_journal_entries WHERE company_id = $1::UUID', [CO]);
  await db.query('DELETE FROM gl_accounts WHERE company_id = $1::UUID', [CO]);
  await db.query('DELETE FROM suppliers WHERE company_id = $1::UUID', [CO]);
  await db.query('DELETE FROM companies WHERE id = $1::UUID', [CO]);
}
