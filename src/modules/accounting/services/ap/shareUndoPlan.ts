/**
 * Plan the "undo share" journals of `void_payment(undo_share: true)` (step 6, 2026-11-13). Reads only.
 *
 * ── THE PATTERN ─────────────────────────────────────────────────────────────
 * A contra supplier payment settles bills by crediting a clearing account X (DR AP / CR X). When the same bills are
 * then paid again some other way (Velocity: paycard lines), a person "shares" each bill back out of X with a journal
 * that reverses its expense and input VAT: DR X / CR the bill's expense legs + CR VAT Input, in the bill's own split
 * (Velocity: JE-2026-16144, re-dated as JE-2026-23852..23856). Voiding one of those contras later leaves X carrying
 * that share for a settlement that no longer exists, so the share is undone for that ONE bill: the mirror journal
 * DR expense legs + DR VAT Input / CR X, dated on the share journal's date (Velocity: JE-2026-29195, JE-2026-31951).
 *
 * ── WHAT THIS REFUSES (throws ShareUndoRefusal, before the void's first write) ──
 *   - a payment that is not a contra (`settlementKind.ts`), or that settled a bank line or a bank-first provisional;
 *   - a payment journal that is not posted and standing, does not debit ONLY Accounts Payable, does not credit
 *     exactly ONE other account X, or posted other live payment documents too;
 *   - a bill whose own journal is not a posted, standing DR legs / CR Accounts Payable posting of its total;
 *   - a share journal that is not this company's posted, standing journal, does not debit X by at least the undo
 *     total, or does not credit every account the undo debits by at least that much — it did not carry this share;
 *   - a share date in a period that is not open, or in a locked VAT period (the undo carries input VAT) — no roll;
 *   - a bill whose share for this payment was already undone (a live journal carries `undo-share:<payment>:<bill>`).
 *
 * ── THE JOURNALS ────────────────────────────────────────────────────────────
 * ONE journal per bill the payment settled, reference `undo-share:<payment_id>:<bill_id>` (the idempotency key a
 * second undo is refused on), dated the share journal's entry date. Amount = what THIS payment applied to that bill,
 * split over the bill's journal debit legs pro rata (`shareUndoSplit.ts`), each leg keeping its account, VAT code
 * and dimensions (project, CC1, CC2, BU); one credit to X for the total.
 */
import { fmtDate } from '@/lib/fmtDate';
import { formatMoney } from '@/lib/money/formatMoney';
import type { JournalLineInput, VatType } from '../../types/gl.types';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { findActiveVatLock, journalMovesVatFigure, lineMovesVatFigure } from '../gl/journalVatLockGuard';
import { toCents } from './billAllocatable';
import { splitOverLegs } from './shareUndoSplit';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import {
  countSiblingPayments, findPriorUndos, readAccountCode, readBills, readJournalHead, readJournalLines, readPaymentAllocations,
  readPaymentKind, type JournalLineRow,
} from './shareUndoReads';

/** A refusal of the undo, typed so the MCP registry answers its message (code SUPPLIER_PAYMENT_REFUSED). */
export class ShareUndoRefusal extends SupplierPaymentRefusal {
  constructor(message: string, opts?: { retryable?: boolean }) {
    super(message, opts);
    this.name = 'ShareUndoRefusal';
  }
}

/** The payment as the void holds it, locked, at the hook. */
export interface VoidingPayment {
  id: string;
  paymentNumber: string | null;
  journalEntryId: string | null;
  settlesProvisionalJeId: string | null;
  bankTransactionId: string | null;
}

export interface ShareUndoJournalPlan {
  billId: string;
  billNumber: string;
  amount: number;
  reference: string;
  description: string;
  lines: JournalLineInput[];
}

export interface ShareUndoPlan {
  paymentId: string;
  paymentNumber: string | null;
  clearingAccount: { id: string; code: string | null; name: string | null };
  shareJournal: { id: string; entryNumber: string | null; entryDate: string };
  journals: ShareUndoJournalPlan[];
  total: number;
  /** Allocation rows the void will unwind — checked against what it reports. */
  allocationRows: number;
}

export const undoShareReference = (paymentId: string, billId: string) => `undo-share:${paymentId}:${billId}`;

const standing = (h: { status: string; reversed: boolean } | null) => h !== null && h.status === 'posted' && !h.reversed;
const cents = (n: number) => toCents(n);

export async function planShareUndo(
  companyId: string, payment: VoidingPayment, shareJournalId: string,
): Promise<ShareUndoPlan> {
  const label = `Payment ${payment.paymentNumber ?? payment.id}`;
  if (payment.bankTransactionId || payment.settlesProvisionalJeId) {
    throw new ShareUndoRefusal(`${label} settled a bank statement line, not a contra — there is no share to undo.`);
  }
  if ((await readPaymentKind(companyId, payment.id)) !== 'contra') {
    throw new ShareUndoRefusal(`${label} is not a contra settlement (it pays from a bank or cash account) — `
      + 'there is no share to undo. Void it without undo_share.');
  }
  const head = payment.journalEntryId ? await readJournalHead(companyId, payment.journalEntryId) : null;
  if (!standing(head)) throw new ShareUndoRefusal(`${label} has no posted, standing journal — there is no share to undo.`);
  const ap = (await getSystemAccount('payable', companyId)).id;
  const payLines = await readJournalLines(companyId, head!.id);
  const xAccounts = [...new Set(payLines.filter((l) => l.credit > 0 && l.glAccountId !== ap).map((l) => l.glAccountId))];
  if (payLines.some((l) => l.debit > 0 && l.glAccountId !== ap) || xAccounts.length !== 1) {
    throw new ShareUndoRefusal(`${label}'s journal is not a contra of the shape DR Accounts Payable / CR one clearing `
      + 'account — undo its share by hand.');
  }
  const x = payLines.find((l) => l.glAccountId === xAccounts[0])!;
  if ((await countSiblingPayments(companyId, head!.id, payment.id)) > 0) {
    throw new ShareUndoRefusal(`${label}'s journal posted other payment documents too — undo its share by hand.`);
  }

  const allocations = await readPaymentAllocations(payment.id);
  if (allocations.length === 0) throw new ShareUndoRefusal(`${label} is applied to no bill — there is no share to undo.`);
  const bills = await readBills(companyId, allocations.map((a) => a.billId));
  const journals: ShareUndoJournalPlan[] = [];
  for (const a of allocations) {
    const bill = bills.get(a.billId);
    if (!bill) throw new ShareUndoRefusal(`${label} is applied to a bill this company does not hold.`);
    journals.push(await billUndo(companyId, payment, bill, a.amount, ap, x));
  }

  const share = await assertShareCarried(companyId, shareJournalId, x, journals);
  await assertDateOpen(companyId, share.entryDate, journals);
  const prior = await findPriorUndos(companyId, journals.map((j) => j.reference));
  for (const j of journals) {
    const by = prior.get(j.reference);
    if (by) throw new ShareUndoRefusal(`The share of ${j.billNumber} for ${label} was already undone by ${by}.`);
  }
  return {
    paymentId: payment.id, paymentNumber: payment.paymentNumber,
    clearingAccount: { id: x.glAccountId, code: x.accountCode, name: x.accountName },
    shareJournal: { id: share.id, entryNumber: share.entryNumber, entryDate: share.entryDate },
    journals: journals.map((j) => ({ ...j, description: `${j.description} (share ${share.entryNumber ?? share.id})` })),
    total: journals.reduce((s, j) => s + cents(j.amount), 0) / 100,
    allocationRows: allocations.reduce((s, a) => s + a.rows, 0),
  };
}

async function billUndo(
  companyId: string, payment: VoidingPayment, bill: { id: string; invoiceNumber: string; totalAmount: number;
    journalEntryId: string | null }, amount: number, ap: string, x: JournalLineRow,
): Promise<ShareUndoJournalPlan> {
  const notPlain = `Bill ${bill.invoiceNumber}'s journal is not a plain posting (DR expense + VAT Input / CR Accounts `
    + 'Payable of its total) — undo its share by hand.';
  const head = bill.journalEntryId ? await readJournalHead(companyId, bill.journalEntryId) : null;
  if (!standing(head)) throw new ShareUndoRefusal(`Bill ${bill.invoiceNumber} has no posted, standing journal to mirror.`);
  const lines = await readJournalLines(companyId, head!.id);
  const legs = lines.filter((l) => l.debit > 0 && l.glAccountId !== ap);
  const apCredit = lines.filter((l) => l.credit > 0).reduce((s, l) => s + cents(l.credit), 0);
  const legTotal = legs.reduce((s, l) => s + cents(l.debit), 0);
  if (lines.some((l) => l.credit > 0 && l.glAccountId !== ap) || lines.some((l) => l.debit > 0 && l.glAccountId === ap)
    || legs.length === 0 || apCredit !== cents(bill.totalAmount) || legTotal !== apCredit) {
    throw new ShareUndoRefusal(notPlain);
  }
  if (legs.some((l) => l.glAccountId === x.glAccountId)) throw new ShareUndoRefusal(notPlain);
  if (cents(amount) > legTotal) {
    throw new ShareUndoRefusal(`Payment ${payment.paymentNumber ?? payment.id} applied more to ${bill.invoiceNumber} `
      + 'than the bill posted — undo its share by hand.');
  }
  const split = splitOverLegs(cents(amount), legs.map((l) => ({ cents: cents(l.debit), isVat: lineMovesVatFigure(null, l.accountSubtype) })));
  const memo = `Undo share: ${bill.invoiceNumber}, ${payment.paymentNumber ?? payment.id} voided`;
  const debits: JournalLineInput[] = legs.flatMap((l, i) => (split[i]! > 0 ? [{
    glAccountId: l.glAccountId, debit: split[i]! / 100, credit: 0, description: memo,
    ...(l.vatType ? { vatType: l.vatType as VatType } : {}),
    // The legacy cost_center_id is not carried, as reversals do not carry it (gl/reversalLines): nothing reads it, CC1
    // and CC2 hold the cost centre, and createJournalEntry refuses a line that names it.
    ...(l.projectId ? { projectId: l.projectId } : {}),
    ...(l.cc1Id ? { cc1Id: l.cc1Id } : {}), ...(l.cc2Id ? { cc2Id: l.cc2Id } : {}), ...(l.buId ? { buId: l.buId } : {}),
  }] : []));
  return {
    billId: bill.id, billNumber: bill.invoiceNumber, amount: cents(amount) / 100,
    reference: undoShareReference(payment.id, bill.id), description: memo,
    lines: [...debits, { glAccountId: x.glAccountId, debit: 0, credit: cents(amount) / 100, description: memo }],
  };
}

/** The share journal really carried these shares: posted, standing, DR X and CR every undone account, by enough. */
async function assertShareCarried(
  companyId: string, shareJournalId: string, x: JournalLineRow, journals: readonly ShareUndoJournalPlan[],
) {
  const head = await readJournalHead(companyId, shareJournalId);
  if (!head) throw new ShareUndoRefusal('share_journal_id is not a journal of this company.');
  const name = head.entryNumber ?? head.id;
  if (!standing(head)) throw new ShareUndoRefusal(`Share journal ${name} is not posted and standing (status ${head.status}${head.reversed ? ', reversed' : ''}).`);
  const lines = await readJournalLines(companyId, head.id);
  const sum = (account: string, side: 'debit' | 'credit') =>
    lines.filter((l) => l.glAccountId === account).reduce((s, l) => s + cents(l[side]), 0);
  const total = journals.reduce((s, j) => s + cents(j.amount), 0);
  if (sum(x.glAccountId, 'debit') < total) {
    throw new ShareUndoRefusal(`Share journal ${name} does not debit ${x.accountCode ?? x.glAccountId} `
      + `${x.accountName ?? ''} (the account this payment credits) by the ${formatMoney(total / 100)} being undone — `
      + 'it is not the share of these bills.');
  }
  const need = new Map<string, number>();
  for (const l of journals.flatMap((j) => j.lines)) if (l.debit > 0) need.set(l.glAccountId, (need.get(l.glAccountId) ?? 0) + cents(l.debit));
  for (const [account, want] of need) {
    if (sum(account, 'credit') < want) {
      const code = await readAccountCode(companyId, account);
      throw new ShareUndoRefusal(`Share journal ${name} does not credit account ${code} by the `
        + `${formatMoney(want / 100)} the bills posted there — it is not the share of these bills.`);
    }
  }
  return head;
}

async function assertDateOpen(companyId: string, date: string, journals: readonly ShareUndoJournalPlan[]) {
  if ((await getPeriodStatusForDate(companyId, date)) !== 'open') {
    throw new ShareUndoRefusal(`The undo is dated on the share journal's date, ${date}, which is not in an open fiscal `
      + 'period — re-open it first (it is never rolled to another date).');
  }
  const lock = await findActiveVatLock(companyId, date);
  if (lock && await journalMovesVatFigure(companyId, journals.flatMap((j) => j.lines))) {
    throw new ShareUndoRefusal(`The undo is dated on the share journal's date, ${fmtDate(date)}, inside the locked VAT `
      + `period ${lock.periodStart} to ${lock.periodEnd}, and it moves input VAT — unlock the period first (it is `
      + 'never rolled to another date).');
  }
}
