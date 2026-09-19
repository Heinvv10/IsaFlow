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

// ── The re-allocated pair ───────────────────────────────────────────────────
//
// The production shape migration 679 exists for. A line was allocated once
// (journal J1, document D1), D1 was cancelled and J1 reversed with it, and the
// line was then re-allocated — producing journal J2 and, before #343, NO second
// document. D1 still carries the bank transaction id in its `reference`, which
// is the only link left between it and the line.
//
// The two differ in ONE field, D1's status, and that is the point: it is the
// A/B that proves the classifier reads the status rather than the reference.
/** D1 cancelled, J1 reversed, J2 standing with no document -> mint one. */
export const REALLOC_TX = '00000000-0000-0000-0000-0000000bf111';
/** D1 alive on J1 while J2 stands -- an anomaly, reported, never minted over. */
export const LIVE_OTHER_TX = '00000000-0000-0000-0000-0000000bf112';
/** J1: the journal the FIRST allocation posted. Deliberately NOT `journalFor`'s
 *  0bf2 range, so an assertion naming J1 cannot be read as naming J2. */
export const REALLOC_J1 = '00000000-0000-0000-0000-0000000bf411';
export const LIVE_OTHER_J1 = '00000000-0000-0000-0000-0000000bf412';
export const REALLOC_AMOUNT = 2300;
export const LIVE_OTHER_AMOUNT = 2400;
/**
 * D1 cancelled, but J1's only reversal is a DRAFT entry — so J1 still stands
 * and its cash is still on the control account behind a cancelled document.
 * 615's outcome, and the one a reverser test that ignores `status` would lose.
 */
export const DRAFT_REV_TX = '00000000-0000-0000-0000-0000000bf113';
export const DRAFT_REV_J1 = '00000000-0000-0000-0000-0000000bf413';
export const DRAFT_REV_AMOUNT = 2500;
/**
 * The line's OWN journal, reversed by a posted entry that named it while
 * leaving `reversed_at` unset — the shape a hand-posted reversal has. Minting
 * against it would document cash the ledger has already taken back.
 */
export const OWN_REVERSER_TX = '00000000-0000-0000-0000-0000000bf114';
export const OWN_REVERSER_AMOUNT = 2600;

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
  // Cancelled document, REVERSED journal, and the line re-allocated onto a
  // journal that stands with nothing pointing at it. Before 679 the cancelled
  // document's `reference` alone made this `document_cancelled_journal_stands`
  // — naming a journal that had in fact been reversed, and leaving the cash
  // the standing journal moved with no document at all.
  [REALLOC_TX, 'create', REALLOC_AMOUNT],
  // Same shape, one field different: the document is LIVE. It points at a
  // journal that is not this line's, so it neither finishes the line nor
  // licenses minting a second document beside it.
  [LIVE_OTHER_TX, 'document_on_other_journal', LIVE_OTHER_AMOUNT],
  // A DRAFT reversal reverses nothing. J1 stands, its cancelled document
  // stands with it, and this is still 615's outcome.
  [DRAFT_REV_TX, 'document_cancelled_journal_stands', DRAFT_REV_AMOUNT],
  // `reversed_at` is NULL and the status is 'posted'. The only witness that
  // this line's own journal was reversed is the posted entry naming it.
  [OWN_REVERSER_TX, 'journal_reversed', OWN_REVERSER_AMOUNT],
];
export const NOHIST_TX = '00000000-0000-0000-0000-0000000bf10d';
export const CREATE_TX = CASES[0]![0];
// ── The two refund shapes (migration 681) ──────────────────────────────────
//
// Money IN against a supplier: DR Bank / CR Accounts Payable. Before 681 the
// view filtered `b.amount < 0` and this line was classified NOWHERE — not
// skipped, invisible — while its journal sat on the control account under
// `posting_with_no_document`. It now mints a NEGATIVE on-account entry.
/** Money IN against a supplier, with its journal: `create_refund`. */
export const REFUND_TX = '00000000-0000-0000-0000-0000000bf110';
export const REFUND_JE = '00000000-0000-0000-0000-0000000bf210';
export const REFUND_AMOUNT = 2500;

/**
 * The shape that CANNOT be minted: a deposit allocated straight to the AP
 * CONTROL ACCOUNT. The journal credits the payable without naming a supplier,
 * so there is no supplier whose on-account credit the refund belongs to and no
 * amount of SQL can decide whose money it is. Reported, never minted.
 * One line on production — R120,290.00 against RohCap.
 */
export const CONTROL_REFUND_TX = '00000000-0000-0000-0000-0000000bf115';
export const CONTROL_REFUND_JE = '00000000-0000-0000-0000-0000000bf215';
export const CONTROL_REFUND_AMOUNT = 2700;

/**
 * The CEILING (migration 682). A refund returns credit the company was
 * holding and cannot return more than it held; past that the supplier owes the
 * company, which is a receivable and belongs on no payable document. The
 * attended path refuses it outright; the batch path reports it here.
 *
 * `ON_ACCOUNT` below is what makes the ordinary refund pass and this one fail,
 * and it is a SEEDED payment rather than a figure derived from the other
 * cases: deriving it would make this outcome depend on which other fixture
 * rows happen to be processed, and the first unrelated case added would flip
 * it with no test naming the reason.
 */
export const EXCESS_REFUND_TX = '00000000-0000-0000-0000-0000000bf116';
export const EXCESS_REFUND_JE = '00000000-0000-0000-0000-0000000bf216';
export const EXCESS_REFUND_AMOUNT = 90000;

/** Unapplied cash on SUP's account, dated before every refund line. */
export const ON_ACCOUNT = '00000000-0000-0000-0000-0000000bf117';
export const ON_ACCOUNT_AMOUNT = 10000;

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

/**
 * The payment a batch created FOR ONE NAMED BANK LINE. A batch mints more than
 * one document, so `rows[0]` of an unordered SELECT is whichever row the heap
 * hands back — the caller names the line it means.
 */
export async function createdPaymentId(
  db: Pool, batch: string, bankTransactionId: string,
): Promise<string> {
  const r = await db.query(
    `SELECT supplier_payment_id::TEXT AS id FROM ap_payment_document_backfill
      WHERE batch_id = $1::UUID AND outcome = 'created' AND rolled_back_at IS NULL
        AND bank_transaction_id = $2::UUID`,
    [batch, bankTransactionId],
  );
  if (r.rows.length !== 1) {
    throw new Error(`expected 1 created payment for ${bankTransactionId}, got ${r.rows.length}`);
  }
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
         outcome === 'journal_reversed' && txId !== OWN_REVERSER_TX ? new Date() : null],
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

    // DRAFT_REV_TX reaches the same outcome by a DIFFERENT route and builds its
    // own document below: a cancelled document on J1, not on this line's own
    // journal. One here too would satisfy the journal arm outright and the case
    // would pass without the reversal ever being consulted.
    if (txId !== DRAFT_REV_TX
        && (outcome === 'already_has_document' || outcome === 'document_cancelled_journal_stands')) {
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

  // ── The first allocation, behind the re-allocated pair ────────────────────
  //
  // The CASES loop above has already built each line's CURRENT journal (J2) and
  // the bank row matched to it. This adds what came before: J1, the journal the
  // first allocation posted; the entry that reversed it; and D1, the document
  // that allocation created, carrying the bank transaction id in `reference`
  // and J1 in `gl_journal_entry_id`.
  //
  // J1 is `posted` WITH `reversed_at` set and a reversing entry pointing at it,
  // because that is how production carries a reversed entry — both signals, and
  // the status stays 'posted'. A classifier that reads only `status` sees a
  // journal that stands.
  for (const [txId, j1Id, amount, docStatus, j1Reversed, reverserStatus] of [
    [REALLOC_TX, REALLOC_J1, REALLOC_AMOUNT, 'cancelled', true, 'posted'],
    [LIVE_OTHER_TX, LIVE_OTHER_J1, LIVE_OTHER_AMOUNT, 'processed', true, 'posted'],
    // `reversed_at` unset and the reverser DRAFT: J1 stands on every signal.
    [DRAFT_REV_TX, DRAFT_REV_J1, DRAFT_REV_AMOUNT, 'cancelled', false, 'draft'],
  ] as const) {
    const tag = txId.slice(-4);
    await db.query(
      `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, source, status, created_by, posted_by, posted_at, reversed_at)
       VALUES ($1,$2,$3,'2026-03-10',$4,'auto_supplier_payment','posted',$5,$5,NOW(),$6)`,
      [j1Id, CO, `BF-JE1-${tag}`, `Payment to ${SUP_NAME}`, USER, j1Reversed ? new Date() : null]);
    await db.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,0,'AP leg'), ($1,$2,$5,0,$4,'Bank leg')`,
      [CO, j1Id, AP, amount, BANK]);
    // The reverser. `reversal_of_id` is the other half of the signal, and the
    // UNIQUE on (company_id, reversal_of_id) allows exactly this one. Its
    // STATUS is the whole of the draft case: an unposted entry has moved no
    // money and reverses nothing.
    const rev = await db.query(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, posted_by, posted_at, reversal_of_id)
       VALUES ($1,$2,'2026-03-11',$3,'auto_supplier_payment',$6,$4,$4,NOW(),$5) RETURNING id::TEXT`,
      [CO, `BF-JER-${tag}`, `Reversal of payment to ${SUP_NAME}`, USER, j1Id, reverserStatus]);
    await db.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
       VALUES ($1,$2,$3,0,$4,'AP leg reversed'), ($1,$2,$5,$4,0,'Bank leg reversed')`,
      [CO, String(rev.rows[0]!.id), AP, amount, BANK]);
    // D1. Found by `reference` and by nothing else — its journal is J1, which
    // is not the journal this bank line now carries.
    await db.query(
      `INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, bank_account_id, reference, status, gl_journal_entry_id, created_by)
       VALUES ($1,$2,'2026-03-10',$3,'eft',$4,$5,$6,$7,$8)`,
      [CO, SUP, amount, BANK, txId, docStatus, j1Id, USER]);
  }

  // The posted entry that reverses THIS line's own journal while leaving
  // `reversed_at` NULL. Nothing else marks that journal as reversed.
  await db.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, posted_by, posted_at, reversal_of_id)
     VALUES ($1,'BF-JER-OWN','2026-03-16',$2,'auto_supplier_payment','posted',$3,$3,NOW(),$4)`,
    [CO, `Reversal of payment to ${SUP_NAME}`, USER, journalFor(OWN_REVERSER_TX)]);

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

  // ── The credit the refunds are measured against ──────────────────────────
  //
  // Carries NEITHER a journal NOR a reference, so it finishes no bank line and
  // cannot be mistaken for one line's document. It exists only to put R10,000
  // on SUP's account, which is what makes REFUND_TX (R2,500) admissible and
  // EXCESS_REFUND_TX (R90,000) not.
  await db.query(
    `INSERT INTO supplier_payments (id, company_id, supplier_id, payment_date, total_amount,
       payment_method, bank_account_id, status, created_by)
     VALUES ($1,$2,$3,'2026-03-01',$4,'eft',$5,'processed',$6) ON CONFLICT (id) DO NOTHING`,
    [ON_ACCOUNT, CO, SUP, ON_ACCOUNT_AMOUNT, BANK, USER]);

  // ── The refund: money IN against the same supplier ────────────────────────
  //
  // DR Bank / CR Accounts Payable — the exact mirror of the payment journals
  // above, and the reason the view's guards are stated as SIGNED MOVEMENTS.
  await db.query(
    `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1,$2,'JE-REFUND','2026-03-16','Refund from supplier','posted','auto_supplier_payment',$3)`,
    [REFUND_JE, CO, USER]);
  await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,0,$4,'AP leg')`, [CO, REFUND_JE, AP, REFUND_AMOUNT]);
  const refundBank = await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,$4,0,'Bank leg') RETURNING id::TEXT`,
    [CO, REFUND_JE, BANK, REFUND_AMOUNT]);
  await db.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, allocation_type, allocated_entity_name, matched_journal_line_id)
     VALUES ($1,$2,$3,'2026-03-16',$4,'Fixture refund','allocated','supplier',$5,$6)`,
    [REFUND_TX, CO, BANK, REFUND_AMOUNT, SUP_NAME, String(refundBank.rows[0]!.id)],
  );

  // ── The control-account refund: same journal shape, no supplier named ─────
  //
  // `allocation_type = 'account'` and `allocated_entity_name` is a GL account
  // LABEL, not a supplier name — which is why it resolves to no supplier and
  // why `supplier_unresolved` would be the wrong outcome to report: nobody can
  // fix this by correcting a supplier record.
  await db.query(
    `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1,$2,'JE-CTRLREF','2026-03-17','Refund on the control account','posted','auto_bank_recon',$3)`,
    [CONTROL_REFUND_JE, CO, USER]);
  await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,0,$4,'AP leg')`, [CO, CONTROL_REFUND_JE, AP, CONTROL_REFUND_AMOUNT]);
  const ctrlBank = await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,$4,0,'Bank leg') RETURNING id::TEXT`,
    [CO, CONTROL_REFUND_JE, BANK, CONTROL_REFUND_AMOUNT]);
  await db.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, allocation_type, allocated_entity_name, matched_journal_line_id)
     VALUES ($1,$2,$3,'2026-03-17',$4,'Fixture control refund','allocated','account',$5,$6)`,
    [CONTROL_REFUND_TX, CO, BANK, CONTROL_REFUND_AMOUNT, '2110 Accounts Payable',
      String(ctrlBank.rows[0]!.id)],
  );

  // ── The refund that BREACHES the ceiling ─────────────────────────────────
  //
  // Same journal shape as the admissible one, same supplier, same direction —
  // only the amount differs, so a test that passes here is testing the ceiling
  // and nothing else.
  await db.query(
    `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1,$2,'JE-BIGREF','2026-03-18','Large refund from supplier','posted','auto_supplier_payment',$3)`,
    [EXCESS_REFUND_JE, CO, USER]);
  await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,0,$4,'AP leg')`, [CO, EXCESS_REFUND_JE, AP, EXCESS_REFUND_AMOUNT]);
  const bigBank = await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     VALUES ($1,$2,$3,$4,0,'Bank leg') RETURNING id::TEXT`,
    [CO, EXCESS_REFUND_JE, BANK, EXCESS_REFUND_AMOUNT]);
  await db.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status, allocation_type, allocated_entity_name, matched_journal_line_id)
     VALUES ($1,$2,$3,'2026-03-18',$4,'Fixture excess refund','allocated','supplier',$5,$6)`,
    [EXCESS_REFUND_TX, CO, BANK, EXCESS_REFUND_AMOUNT, SUP_NAME, String(bigBank.rows[0]!.id)],
  );
}

export async function cleanup(db: Pool): Promise<void> {
  for (const co of [CO, CO2]) await cleanupCompany(db, co);
  await db.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[USER, USER2]]);
}

export async function cleanupCompany(db: Pool, CO: string): Promise<void> {
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
