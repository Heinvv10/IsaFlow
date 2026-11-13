/**
 * Plan the "undo share" journals of `void_payment(undo_share: true)` (step 6, 2026-11-13). Reads only (one lock).
 *
 * ── THE PATTERN ─────────────────────────────────────────────────────────────
 * A contra supplier payment settles bills by crediting a clearing account X (DR AP / CR X). When the same bills are
 * then paid again some other way (Velocity: paycard lines), a person "shares" each bill back out of X with a journal
 * that reverses its expense and input VAT: DR X / CR the bill's expense legs + CR VAT Input, in the bill's own split
 * (Velocity: JE-2026-16144, re-dated as JE-2026-23852..23856). Voiding one of those contras later leaves X carrying
 * that share for a settlement that no longer exists, so the share is undone for that ONE bill: the mirror journal
 * DR expense legs + DR VAT Input / CR X, dated on the share journal's date (Velocity: JE-2026-29195, JE-2026-31951).
 *
 * ── WHAT THIS REFUSES (ShareUndoRefusal, before the void's first write) ─────
 *   - a payment that is not a contra (`settlementKind.ts`; 'unclassified' too), or that settled a bank line or a
 *     bank-first provisional;
 *   - a payment journal that is not posted and standing, does not debit ONLY Accounts Payable (any payable-subtype
 *     account), does not credit exactly ONE other account X, or posted other live payment documents too;
 *   - a bill whose own journal is not a posted, standing DR legs / CR AP posting of its total, or was late-claimed
 *     (s16(3): its VAT sits on the clearing account and the claim on a companion — undo by hand);
 *   - a share journal that is not this company's posted, standing MANUAL journal (manual / GL import / recurring), or
 *     no longer HOLDS what this undo gives
 *     back — cumulatively across every live undo of it, linked or by hand (`shareUndoGuards.ts`);
 *   - a share that debits X by more than this payment applied (it carries other bills, and its lines do not say how
 *     much of each) unless `undo_amounts` says how much of each bill it reversed;
 *   - another REVERSED share of the same shape (any source) dated on or after the earliest undone bill or the share —
 *     a re-dated share whose reversal may already have restored the bill (rounds 5-6, `findRedatedShares`);
 *   - a share date in a period that is not open, or in a locked VAT period — no roll;
 *   - an undo account that is deactivated or a header;
 *   - a live journal already carrying `undo-share:<payment>:<bill>`. Belt and braces: a voided payment is refused
 *     `already_cancelled` before this runs, so this fires only for a journal written by hand with that reference;
 *     the capacity check is what stops a second undo of a share.
 *
 * `undo_amounts` is TRUSTED as given (within what the payment applied and what the share still holds per account):
 * the share's lines do not say which bill each amount belongs to, so the figure must come from the share's own
 * working. The per-account capacity is the only cap that can be computed.
 *
 * ── THE JOURNALS ────────────────────────────────────────────────────────────
 * ONE journal per bill undone, reference `undo-share:<payment_id>:<bill_id>`, `source_record_id` = the share journal
 * (the link the capacity check sums by), dated the share's entry date. Amount = what THIS payment applied to the bill
 * (or the `undo_amounts` figure), split over the bill's journal debit legs pro rata (`shareUndoSplit.ts`), each leg
 * keeping its account, VAT code and dimensions (project, CC1, CC2, BU); one credit to X for the total.
 */
import { canonicalSubtype } from '../gl/accountSubtypes';
import { lineMovesVatFigure } from '../gl/journalVatLockGuard';
import type { JournalLineInput, VatType } from '../../types/gl.types';
import type { VoidingPayment } from '../core/paymentVoidService';
import { formatMoney } from '@/lib/money/formatMoney';
import { toCents } from './billAllocatable';
import { splitOverLegs } from './shareUndoSplit';
import {
  ShareUndoRefusal, undoShareReference, type ShareUndoChoices, type ShareUndoJournalPlan, type ShareUndoPlan,
} from './shareUndoTypes';
import { assertAccountsPostable, assertDateOpen, assertShareCapacity } from './shareUndoGuards';
import { SHARE_SOURCES, findRedatedShares } from './shareUndoHandUndos';
import {
  countSiblingPayments, findPriorUndos, hasLateClaimCompanion, lockShareJournal, readBills, readJournalHead,
  readJournalLines, readPaymentAllocations, readPaymentKind, type BillRow, type JournalLineRow,
} from './shareUndoReads';

export { ShareUndoRefusal } from './shareUndoTypes';

const standing = (h: { status: string; reversed: boolean } | null) => h !== null && h.status === 'posted' && !h.reversed;
const cents = (n: number) => toCents(n);
const isAp = (l: JournalLineRow) => canonicalSubtype(l.accountSubtype) === 'payable';


export async function planShareUndo(
  companyId: string, payment: VoidingPayment, shareJournalId: string, choices: ShareUndoChoices = {},
): Promise<ShareUndoPlan> {
  const label = `Payment ${payment.paymentNumber ?? payment.id}`;
  if (payment.bankTransactionId || payment.settlesProvisionalJeId) {
    throw new ShareUndoRefusal(`${label} settled a bank statement line, not a contra — there is no share to undo.`);
  }
  const kind = await readPaymentKind(companyId, payment.id);
  if (kind !== 'contra') {
    throw new ShareUndoRefusal(kind === 'unclassified'
      ? `${label} credits an account with no subtype and no statement lines, so it cannot be told from a bank payment `
        + '— set the account\'s subtype first.'
      : `${label} is not a contra settlement (it pays from a bank or cash account) — there is no share to undo. `
        + 'Void it without undo_share.');
  }
  const head = payment.journalEntryId ? await readJournalHead(companyId, payment.journalEntryId) : null;
  if (!standing(head)) throw new ShareUndoRefusal(`${label} has no posted, standing journal — there is no share to undo.`);
  const payLines = await readJournalLines(companyId, head!.id);
  const xAccounts = [...new Set(payLines.filter((l) => l.credit > 0 && !isAp(l)).map((l) => l.glAccountId))];
  if (payLines.some((l) => l.debit > 0 && !isAp(l)) || xAccounts.length !== 1) {
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
  const allocatedCents = allocations.reduce((s, a) => s + cents(a.amount), 0);

  // After the payment lock (the void's), the share's head: every undo takes them in this order.
  await lockShareJournal(companyId, shareJournalId);
  const share = await readJournalHead(companyId, shareJournalId);
  if (!share) throw new ShareUndoRefusal('share_journal_id is not a journal of this company.');
  const name = share.entryNumber ?? share.id;
  if (!standing(share)) throw new ShareUndoRefusal(`Share journal ${name} is not posted and standing (status ${share.status}${share.reversed ? ', reversed' : ''}).`);
  if (!SHARE_SOURCES.includes(share.source ?? 'manual')) {
    throw new ShareUndoRefusal(`Journal ${name} is a ${share.source} posting (a document's or the system's own journal), not a `
      + 'share: a share is a manual journal (entered by hand, imported or recurring). Name the journal that took the '
      + 'bills out of the clearing account.');
  }
  const shareLines = await readJournalLines(companyId, share.id);
  const shareOnX = shareLines.filter((l) => l.glAccountId === x.glAccountId).reduce((s, l) => s + cents(l.debit), 0);

  const amounts = undoAmounts(label, allocations, choices, shareOnX, allocatedCents, name);
  const journals: ShareUndoJournalPlan[] = [];
  const legsByAccount = new Map<string, JournalLineRow>();
  const billDates: string[] = [];
  for (const a of allocations) {
    const want = amounts.get(a.billId);
    if (!want) continue;
    const bill = bills.get(a.billId);
    if (!bill) throw new ShareUndoRefusal(`${label} is applied to a bill this company does not hold.`);
    const { journal, legs, postedOn } = await billUndo(companyId, label, payment.id, bill, want, x);
    for (const l of legs) legsByAccount.set(l.glAccountId, l);
    billDates.push(bill.invoiceDate, postedOn);
    journals.push(journal);
  }
  legsByAccount.set(x.glAccountId, x);

  const prior = await findPriorUndos(companyId, share.id, journals);
  for (const j of journals) {
    const by = prior.get(j.billId);
    if (by) throw new ShareUndoRefusal(`The share of ${j.billNumber} for ${label} was already undone by ${by}.`);
  }
  await assertShareCapacity(companyId, share, shareLines, x, journals, billDates);
  // Round 5: a share reversed and re-posted in the window may have left this bill out; its reversal already
  // restored it. Indistinguishable from a re-post that kept it, so refused outright.
  const redated = await findRedatedShares(companyId, share.id, x.glAccountId, billDates);
  if (redated.length > 0) {
    throw new ShareUndoRefusal(`Share journal${redated.length === 1 ? '' : 's'} ${redated.slice(0, 10).join(', ')}`
      + `${redated.length > 10 ? ` and ${redated.length - 10} more` : ''} of the same shape (clearing account `
      + `${x.accountCode ?? x.glAccountId}, the same accounts, dated on or after these bills) ${redated.length === 1 ? 'was' : 'were'} `
      + 'reversed — a share re-dated by reverse-and-repost, whose reversal may already have restored this bill. '
      + 'Undo the share by hand after checking which bills the re-posted share carries.');
  }
  await assertDateOpen(companyId, share.entryDate, journals);
  await assertAccountsPostable(companyId, legsByAccount, journals);
  return {
    paymentId: payment.id, paymentNumber: payment.paymentNumber,
    clearingAccount: { id: x.glAccountId, code: x.accountCode, name: x.accountName },
    shareJournal: { id: share.id, entryNumber: share.entryNumber, entryDate: share.entryDate },
    journals: journals.map((j) => ({ ...j, description: `${j.description} (share ${name})` })),
    total: journals.reduce((s, j) => s + cents(j.amount), 0) / 100,
    allocatedTotal: allocatedCents / 100,
    allocationRows: allocations.reduce((s, a) => s + a.rows, 0),
  };
}

/** Cents per bill: what the payment applied, or — when the share carries other bills too — what the caller says. */
function undoAmounts(
  label: string, allocations: readonly { billId: string; amount: number }[], choices: ShareUndoChoices,
  shareOnX: number, allocatedCents: number, shareName: string,
): Map<string, number> {
  if (!choices.undoAmounts) {
    if (shareOnX > allocatedCents) {
      throw new ShareUndoRefusal(`Share journal ${shareName} debits the clearing account by ${formatMoney(shareOnX / 100)}, `
        + `more than ${label} applied (${formatMoney(allocatedCents / 100)}): it carries other bills too, and its lines do `
        + 'not say how much of each. Pass undo_amounts with how much of each of this payment\'s bills it reversed.');
    }
    return new Map(allocations.map((a) => [a.billId, cents(a.amount)]));
  }
  const applied = new Map(allocations.map((a) => [a.billId, cents(a.amount)]));
  const out = new Map<string, number>();
  for (const u of choices.undoAmounts) {
    const max = applied.get(u.billId);
    if (max === undefined) throw new ShareUndoRefusal(`undo_amounts names bill ${u.billId}, which ${label} is not applied to.`);
    if (out.has(u.billId)) throw new ShareUndoRefusal(`undo_amounts names bill ${u.billId} twice.`);
    if (cents(u.amount) <= 0 || cents(u.amount) > max) {
      throw new ShareUndoRefusal(`undo_amounts for bill ${u.billId} must be more than 0 and at most the `
        + `${formatMoney(max / 100)} ${label} applied to it.`);
    }
    out.set(u.billId, cents(u.amount));
  }
  return out;
}

async function billUndo(
  companyId: string, label: string, paymentId: string, bill: BillRow, amountCents: number, x: JournalLineRow,
): Promise<{ journal: ShareUndoJournalPlan; legs: JournalLineRow[]; postedOn: string }> {
  const notPlain = `Bill ${bill.invoiceNumber}'s journal is not a plain posting (DR expense + VAT Input / CR Accounts `
    + 'Payable of its total) — undo its share by hand.';
  const head = bill.journalEntryId ? await readJournalHead(companyId, bill.journalEntryId) : null;
  if (!standing(head)) throw new ShareUndoRefusal(`Bill ${bill.invoiceNumber} has no posted, standing journal to mirror.`);
  const lines = await readJournalLines(companyId, head!.id);
  if (lines.some((l) => canonicalSubtype(l.accountSubtype) === 'vat_input_late_claim') || head!.lateClaimOfId
    || await hasLateClaimCompanion(companyId, head!.id)) {
    throw new ShareUndoRefusal(`Bill ${bill.invoiceNumber} was late-claimed (s16(3)): its input VAT was moved to a later `
      + 'VAT period by a companion journal, so its own journal is not the split to mirror — undo its share by hand.');
  }
  const legs = lines.filter((l) => l.debit > 0 && !isAp(l));
  const apCredit = lines.filter((l) => l.credit > 0).reduce((s, l) => s + cents(l.credit), 0);
  const legTotal = legs.reduce((s, l) => s + cents(l.debit), 0);
  if (lines.some((l) => l.credit > 0 && !isAp(l)) || lines.some((l) => l.debit > 0 && isAp(l))
    || legs.length === 0 || apCredit !== cents(bill.totalAmount) || legTotal !== apCredit
    || legs.some((l) => l.glAccountId === x.glAccountId)) {
    throw new ShareUndoRefusal(notPlain);
  }
  if (amountCents > legTotal) {
    throw new ShareUndoRefusal(`${label} applied more to ${bill.invoiceNumber} than the bill posted — undo its share by hand.`);
  }
  // A leg that moves any VAT201 figure (a tax leg, or a base leg with a VAT code) is never the remainder leg.
  const split = splitOverLegs(amountCents, legs.map((l) => ({ cents: cents(l.debit), isVat: lineMovesVatFigure(l.vatType, l.accountSubtype) })));
  const memo = `Undo share: ${bill.invoiceNumber}, ${label.replace(/^Payment /, '')} voided`;
  const debits: JournalLineInput[] = legs.flatMap((l, i) => (split[i]! > 0 ? [{
    glAccountId: l.glAccountId, debit: split[i]! / 100, credit: 0, description: memo,
    ...(l.vatType ? { vatType: l.vatType as VatType } : {}),
    // The legacy cost_center_id is not carried, as reversals do not carry it (gl/reversalLines): nothing reads it, CC1
    // and CC2 hold the cost centre, and createJournalEntry refuses a line that names it.
    ...(l.projectId ? { projectId: l.projectId } : {}),
    ...(l.cc1Id ? { cc1Id: l.cc1Id } : {}), ...(l.cc2Id ? { cc2Id: l.cc2Id } : {}), ...(l.buId ? { buId: l.buId } : {}),
  }] : []));
  return {
    legs,
    postedOn: head!.entryDate,
    journal: {
      billId: bill.id, billNumber: bill.invoiceNumber, amount: amountCents / 100,
      reference: undoShareReference(paymentId, bill.id), description: memo,
      lines: [...debits, { glAccountId: x.glAccountId, debit: 0, credit: amountCents / 100, description: memo }],
    },
  };
}
