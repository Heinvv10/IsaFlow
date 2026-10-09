/**
 * R-127: which bank-first provisional an approving supplier invoice settles, and
 * every refusal of that decision — all taken BEFORE the approval's first write,
 * so a refusal answered 4xx (which withAuth COMMITs) leaves nothing behind.
 *
 * A provisional qualifies when it is posted, standing by its reversal chain
 * (D8: one reversed and re-reversed books its slip again through the second
 * contra, so it settles like any other), evidenced
 * (`needs_evidence = false`) by the invoice's own source document, in the same
 * company, and linked from `bank_transactions.provisional_je_id` by a line still 'matched' or 'reconciled' (D10).
 * It is LOCKED here (bounded) and only then read for a live payment already holding it
 * (`supplier_payments.settles_provisional_je_id`, migration 711).
 *
 * Refusals, all `SupplierPaymentRefusal` (routes answer 400; MCP surfaces it):
 *   - contended  — another request is settling it (retryable);
 *   - taken      — its cash already paid another bill (or sits unapplied on the
 *                  payment that did): approving this one too books the slip twice;
 *   - lines      — its lines do not add up to its bank line: a reclass would be a guess;
 *   - retired    — a line is on a deactivated account, which refuses every posting;
 *   - filed VAT  — the invoice AND the provisional are both dated in locked VAT
 *                  periods. The provisional's input VAT is in a filed return; the
 *                  invoice's would be claimed late, and the reclass that nets it is an
 *                  input REDUCTION, which the late-claim rules refuse ('input_reduction')
 *                  and no open date can carry. When only the invoice's period is filed,
 *                  the reclass is dated with the provisional and nets its claim there.
 *
 * And one `ApprovalRequiredError` (routes answer 409): the line was keyed by
 * hand and supplier_payment enforcement has a rule matching its amount (R-035
 * PR5 round 2, `bankLinePaymentGate`); and one `BankControlError` (403): the
 * approver imported the line's statement (step 2, `bankLineImporterGate`).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { fmtDate } from '@/lib/fmtDate';
import { getJournalEntryById } from '../gl/journalEntryService';
import { findActiveVatLock, journalMovesVatFigure } from '../gl/journalVatLockGuard';
import type { JournalLine } from '../../types/gl.types';
import { round2 } from './supplierAllocationLines';
import { journalStandsFragment } from '../shared/journalInForceAsAt';
import { lockStandingChainHead } from '../shared/journalChainHead';
import { JournalReversalLockTimeoutError } from '../gl/journalEntryReversalClaim';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { withRowLockBudget } from '../core/rowLockBudget';
import { assertBankLineMayPaySupplier } from './bankLinePaymentGate';
import { assertImporterMayAllocate } from '../bank/bankLineImporterGate';

const CENT = 0.005;

export interface ProvisionalClaim {
  journalEntryId: string;
  entryNumber: string;
  bankTxId: string;
  /** bank_transactions.bank_account_id — a gl_accounts id. */
  bankAccountId: string;
  /** The absolute bank outflow the provisional credited. */
  bankAmount: number;
  /** The provisional's expense / VAT lines — everything but its bank line. */
  settleLines: JournalLine[];
  /** The reclass's and the payment's date: the invoice's, or the provisional's when the invoice's is filed. */
  reclassDate: string;
}

/**
 * The candidates, row-locked under the shared 5 s budget (`core/rowLockBudget`, the caller's lock_timeout restored
 * on every path that leaves the transaction usable — D8 rounds 6 and 9), a timeout naming the provisional.
 */
async function lockCandidates(companyId: string, documentId: string): Promise<DbRow[]> {
  if (!als.getStore()?.client) throw new Error('claimEvidencedProvisional requires a request transaction (withAuth / als.run)');
  const contended = () => new SupplierPaymentRefusal(
    'The bank-first provisional journal behind this slip is being settled by another request — retry in a moment.',
    { retryable: true, held: true },
  );
  try {
    const rows = await withRowLockBudget(async () => (await sql`
      SELECT je.id AS je_id, je.entry_number, bt.id AS bt_id, bt.bank_account_id, bt.amount,
             bt.bank_feed_connection_id, bt.import_batch_id
      FROM gl_journal_entries je
      JOIN bank_transactions bt ON bt.provisional_je_id = je.id AND bt.company_id = je.company_id
        -- D10 O9: its line still on the statement as the provisional's cash. One already reset ('imported' /
        -- 'excluded' before D10 refused that) is free to be allocated again: settling X against it books it twice.
        AND bt.status IN ('matched', 'reconciled')
      WHERE je.company_id = ${companyId}::UUID
        AND je.source_document_id = ${documentId}::UUID
        AND je.status = 'posted'
        AND ${journalStandsFragment('je.id', companyId)}
        AND je.needs_evidence = false
      ORDER BY je.id
      FOR UPDATE OF je
    `) as DbRow[], contended);
    // D8 round 4 (B1): X's row lock does not hold a re-reversed X in the
    // ledger — its HEAD (R2) does, and a reversal of R2 claims R2, not X. So
    // lock the standing head too, under the same budget helper, and drop a candidate
    // whose chain went out meanwhile; the reversal then waits on this lock and
    // meets the settlement in refuseReversingSettlementJournal.
    const standing: DbRow[] = [];
    for (const r of rows) {
      if (await lockStandingChainHead(companyId, String(r.je_id), (m) => new SupplierPaymentRefusal(m))) standing.push(r);
    }
    return standing;
  } catch (err) {
    // The head lock's own timeout reads as this claim's contention, like the candidates' lock.
    if (err instanceof JournalReversalLockTimeoutError) throw contended();
    throw err;
  }
}

/** The live payment already holding this provisional, with the bills it pays. */
async function holderOf(companyId: string, jeId: string): Promise<DbRow | null> {
  const [row] = (await sql`
    SELECT sp.payment_number,
           (SELECT string_agg(si.invoice_number, ', ' ORDER BY si.invoice_number)
              FROM payment_allocations pa JOIN supplier_invoices si ON si.id = pa.invoice_id
             WHERE pa.payment_id = sp.id AND si.company_id = sp.company_id) AS invoices
    FROM supplier_payments sp
    WHERE sp.company_id = ${companyId}::UUID AND sp.settles_provisional_je_id = ${jeId}::UUID
      AND sp.status <> 'cancelled'
    LIMIT 1
  `) as DbRow[];
  return row ?? null;
}

/**
 * The evidenced provisional behind this invoice's source document, LOCKED, or
 * null when none qualifies. Call before the approval's first write.
 */
export async function claimEvidencedProvisional(
  companyId: string,
  invoiceId: string,
  /** Who settles the line as a supplier payment: not the statement's importer, under enforcement (step 2). */
  actorUserId: string,
): Promise<ProvisionalClaim | null> {
  const [inv] = (await sql`
    SELECT source_document_id, invoice_date FROM supplier_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!inv?.source_document_id) return null;

  let taken: { entry: string; holder: DbRow } | null = null;
  for (const c of await lockCandidates(companyId, String(inv.source_document_id))) {
    const jeId = String(c.je_id);
    const entryNumber = String(c.entry_number);
    const holder = await holderOf(companyId, jeId);
    if (holder) {
      taken = { entry: entryNumber, holder };
      continue;
    }

    const entry = await getJournalEntryById(companyId, jeId);
    if (!entry) throw new Error(`Provisional journal ${jeId} not found in company ${companyId}`);
    const bankAccountId = String(c.bank_account_id);
    const bankAmount = round2(Math.abs(Number(c.amount)));
    const bankLines = entry.lines.filter((l) => l.glAccountId === bankAccountId);
    const settleLines = entry.lines.filter((l) => l.glAccountId !== bankAccountId);
    const bankCredit = round2(bankLines.reduce((s, l) => s + l.credit - l.debit, 0));
    const settleDebit = round2(settleLines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (Math.abs(bankCredit - bankAmount) > CENT || Math.abs(settleDebit - bankAmount) > CENT) {
      throw new SupplierPaymentRefusal(
        `Provisional journal ${entryNumber} is evidenced by this invoice's document, but its lines `
        + `(bank R${bankCredit.toFixed(2)}, other R${settleDebit.toFixed(2)}) do not match its bank line of `
        + `R${bankAmount.toFixed(2)}. Approving would book the bill twice; correct or reverse the provisional first.`,
      );
    }

    // postJournalEntry refuses a deactivated account on ANY posting, reversals
    // included (assertNoInactiveAccountLines) — so answer it here, pre-write.
    const retired = (await sql`
      SELECT account_code FROM gl_accounts WHERE company_id = ${companyId}::UUID AND is_active = false
        AND id = ANY(${settleLines.map((l) => l.glAccountId)}::UUID[])
    `) as DbRow[];
    if (retired.length > 0) {
      throw new SupplierPaymentRefusal(
        `Provisional journal ${entryNumber} books this slip on deactivated account(s) `
        + `${retired.map((r) => String(r.account_code)).join(', ')}, so it cannot be reclassed to this bill. `
        + 'Reactivate the account, then approve.',
      );
    }
    // Dated with the invoice, so the reclass nets the invoice's VAT in its own
    // period — unless that period is filed: then with the provisional, whose own
    // claim it nets instead (the invoice's VAT is claimed late, once). Only when
    // both periods are filed is there no date that leaves the filed return alone.
    const invoiceDate = fmtDate(inv.invoice_date as string | Date);
    let reclassDate = invoiceDate;
    const lock = await findActiveVatLock(companyId, invoiceDate);
    if (lock && await journalMovesVatFigure(companyId, settleLines)) {
      const provisionalDate = fmtDate(entry.entryDate);
      if (await findActiveVatLock(companyId, provisionalDate)) {
        throw new SupplierPaymentRefusal(
          `This bill is dated in a filed VAT period (${lock.periodStart} to ${lock.periodEnd}), and its slip is `
          + `already booked, VAT included, by bank-first provisional journal ${entryNumber}, dated ${provisionalDate} `
          + 'in a filed period too, whose input VAT that return claimed. Approving the bill would claim the same '
          + 'VAT again. The provisional already books this slip in full: leave the bill unapproved, or cancel it.',
        );
      }
      reclassDate = provisionalDate;
    }
    // R-035 PR5 round 2: settling writes a processed supplier payment from this
    // line. A hand-keyed one is no evidence the money left (D2), so a matching
    // enforced rule refuses it HERE, from reads — not at the 867 backstop after
    // the bill's journal.
    await assertBankLineMayPaySupplier(companyId, c, bankAmount);
    // Step 2 (Hein, decision 2): nor may the person who imported the line's statement settle it — BankControlError 403.
    await assertImporterMayAllocate(companyId, c, actorUserId, 'supplier_payment');
    return {
      journalEntryId: jeId, entryNumber, bankTxId: String(c.bt_id), bankAccountId, bankAmount, settleLines, reclassDate,
    };
  }

  if (taken) {
    const paid = taken.holder.invoices ? `invoice ${String(taken.holder.invoices)}` : 'a bill (now unapplied on that payment)';
    throw new SupplierPaymentRefusal(
      `The bank line behind this slip already paid ${paid} through payment ${String(taken.holder.payment_number)} `
      + `(bank-first provisional journal ${taken.entry}). Approving this bill as well would book the slip twice — `
      + 'cancel it if it is a duplicate, or apply that payment where it belongs.',
    );
  }
  return null;
}
