/**
 * The PAYER clears a linked bill against the intercompany loan (intercompany P4-E, plan docs/plans/2026-11-24-intercompany-p4e-payer-loan-clearing.md,
 * section (j) binding): a person with an intercompany write role and Approve on Suppliers & AP presses "Clear against the intercompany loan" on a
 * supplier bill that is the AP side of an ACTIVE link to the partner's customer invoice on an active GROUP LOAN connection. In the request's ONE
 * transaction this re-checks everything under its locks and posts exactly one contra settlement through slice A's `settleDocumentByContra`
 * (subledger `ap`: a `contra` supplier payment created, approved and processed; journal DR Accounts Payable control / CR this company's side
 * `loan_account_id`). The P4-B hook inside `processSupplierPayment` sends the allocation message (`cashLegIsLoanAccount` true); this service
 * writes no message itself, but REQUIRES it afterwards ((j).1): no message, no clearing (a plain Error, so the whole request rolls back).
 *
 * AUTOMATION IS NOT APPROVAL. The actor is the session user (the route passes `req.user.id`; it must equal the bound transaction's user):
 * creator == approver == that person; `system:ic_loan_clear` only labels the journal's author. Only a person's OWN session clears.
 *
 * ORDER: the dark flag (`intercompany_loan_clearing`) first, then the person (own session, write role, Approve: BEFORE anything is read, because
 * the allocation message is silently skipped for a user without the write role and the clearing must then not post), then THE LOCK ORDER
 * (`payerLoanClearReads.ts`: bill FOR UPDATE, connection, side, link, loan account FOR SHARE; tighten-only 5 s bound, a wait that runs out or a
 * deadlock is a 409 with nothing written), then every refusal (`payerLoanClearJudge.ts`), then the ONE posting, then the post-write checks.
 * Every refusal is raised before the first write (a 4xx `withAuth` commits commits nothing); after the posting only a plain Error (5xx) leaves.
 */
import { als } from '@/lib/als';
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { mayApprove, ApprovePermissionError } from '../core/approvePermission';
import { ContraSettlementRefusal, isContraPreWriteRefusal, settleDocumentByContra } from '../core/contraSettlementPosting';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { userCanWrite } from './allocationClearReads';
import { cents } from './allocationClearRefusals';
import { LoanClearingNotEnabled, loanClearingEnabled } from './loanClearingGate';
import { IC_LOAN_CLEAR_AGENT, mintLoanClearPermit } from './loanClearPermit';
import { factsRefusal, postingRefusal, requestRefusal } from './payerLoanClearJudge';
import { journalLinesOf, loadClearingFacts, sentMessagesFor, supplierName, type ClearingFacts } from './payerLoanClearReads';
import { payerRefusal } from './payerLoanClearRefusals';
import type { LoanClearInput, LoanClearResult } from './payerLoanClearTypes';

type Row = Record<string, unknown>;

export interface ClearBillAgainstLoanParams extends LoanClearInput {
  companyId: string;
  /** The session user (the route's `req.user.id`): creator and approver of the clearing. */
  actor: { userId: string };
}

const sqlstate = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

export async function clearBillAgainstLoan(p: ClearBillAgainstLoanParams): Promise<LoanClearResult> {
  const { companyId, billId, actor } = p;
  const userId = actor.userId;
  // Programming errors, not refusals: atomic only inside the request's transaction, and the actor IS its user.
  const store = als.getStore();
  if (!store?.client) throw new Error('clearBillAgainstLoan needs a request transaction');
  if (store.userId !== userId || (store.companyId !== undefined && store.companyId !== companyId)) {
    throw new Error('clearBillAgainstLoan: the actor is not the session user of this company');
  }
  // The payer's dark flag first: off, nothing of the bill, the person or the books is read.
  if (!(await loanClearingEnabled(companyId))) throw new LoanClearingNotEnabled();
  const session = await currentSessionActor();
  if (session === 'impersonation') throw new ImpersonationForbiddenError();
  if (session !== 'self') throw payerRefusal('not_own_session');
  if (!(await userCanWrite(companyId))) throw payerRefusal('no_write_role');
  if (!(await mayApprove(companyId, userId, 'suppliers'))) throw payerRefusal('no_approve');

  const prev = await boundLockWait();
  const facts = await lockFacts(companyId, billId);
  const refusal = factsRefusal(facts) ?? await requestRefusal(companyId, facts, p) ?? await postingRefusal(companyId, facts, p.amount);
  if (refusal) throw payerRefusal(refusal);

  const result = await post(companyId, userId, facts, p);
  await sql`SELECT pg_catalog.set_config('lock_timeout', ${prev}, true)`;
  return result;
}

/** Tighten-only 5 s bound on every row-lock wait of the clearing (never loosening a tighter caller's); the caller's value is put back after. */
async function boundLockWait(): Promise<string> {
  const rows = (await sql`
    SELECT prev, pg_catalog.set_config('lock_timeout', CASE WHEN prev::interval = interval '0' OR prev::interval > interval '5s' THEN '5s' ELSE prev END, true)
      FROM (SELECT pg_catalog.current_setting('lock_timeout') AS prev) s
  `) as Row[];
  return String(rows[0]?.prev ?? '0');
}

/** THE lock order in a savepoint of its own: a wait that runs out (55P03) or a deadlock (40P01) is a 409 with nothing written. */
async function lockFacts(companyId: string, billId: string): Promise<ClearingFacts> {
  try {
    return await withSavepoint('ic_loan_clear_lock', () => loadClearingFacts(companyId, billId, true));
  } catch (err) {
    if (sqlstate(err) === '55P03' || sqlstate(err) === '40P01') throw payerRefusal('busy');
    throw err;
  }
}

/** The ONE posting, then (j).1: the journal is exactly DR AP / CR the loan account and the allocation message exists. */
async function post(companyId: string, userId: string, f: ClearingFacts, input: LoanClearInput): Promise<LoanClearResult> {
  const bill = f.bill!;
  const loanAccountId = f.side!.loanAccountId!;
  const partner = (await supplierName(companyId, f.side!.supplierId)) ?? 'the partner company';
  let posted;
  try {
    posted = await settleDocumentByContra({
      companyId, subledger: 'ap', documentId: bill.id, contraAccountId: loanAccountId, amount: input.amount, date: input.postingDate,
      reason: `Cleared against intercompany loan, partner ${partner}`,
      actor: { userId, approverUserId: userId, postingAgent: IC_LOAN_CLEAR_AGENT },
      loanClearPermit: mintLoanClearPermit({ companyId, billId: bill.id, loanAccountId }),
    });
  } catch (err) {
    // ONLY the service's own pre-write refusals are answered (it wrote nothing); anything else propagates and rolls the request back
    if (isContraPreWriteRefusal(err)) {
      if (err instanceof ApprovePermissionError) throw payerRefusal('no_approve');
      if (err instanceof ContraSettlementRefusal && err.underlying !== undefined) throw payerRefusal('contra_refused');
      if (err.message.startsWith('Supplier payments are enforced')) throw payerRefusal('approval_rule');
    }
    throw err;
  }
  // From here on nothing is a refusal: a plain Error rolls the posting back with the request (no 4xx after a write).
  if (!posted.journalEntryId) throw new Error('the intercompany loan clearing posted no journal');
  const ap = await getSystemAccount('payable', companyId);
  const lines = await journalLinesOf(companyId, posted.journalEntryId);
  const amount = cents(input.amount);
  const exact = lines.length === 2
    && lines.some((l) => l.account === ap.id && l.debitCents === amount && l.creditCents === 0)
    && lines.some((l) => l.account === loanAccountId && l.creditCents === amount && l.debitCents === 0);
  if (!exact) throw new Error('the intercompany loan clearing journal is not DR Accounts Payable / CR the loan account');
  // (j).1 no blind clearing: the allocation message for the new allocation row, built from the journal (it credits the loan account)
  const messages = await sentMessagesFor(companyId, posted.paymentId);
  const message = messages.length === 1 && messages[0]!.cashLeg && cents(messages[0]!.amount) === amount ? messages[0]! : null;
  if (!message) {
    log.error('Intercompany loan clearing rolled back: its allocation message was not written', { companyId, billId: bill.id, found: messages.length }, 'intercompany');
    throw new Error('the intercompany loan clearing could not send its allocation message to the partner');
  }
  log.info('Intercompany bill cleared against the loan', {
    companyId, billId: bill.id, paymentId: posted.paymentId, journalEntryId: posted.journalEntryId, messageId: message.id,
  }, 'intercompany');
  return {
    cleared: true, billId: bill.id, paymentId: posted.paymentId, paymentNumber: posted.paymentNumber, journalEntryId: posted.journalEntryId, messageId: message.id,
  };
}
