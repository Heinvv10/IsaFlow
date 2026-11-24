/**
 * The loan reconciliation's rows and sections (P5, plan section (a)). Pure. A message row (b3 joined to this company's own message and
 * documents), an unsent payment and an unlinked partner bill each become one ReconItem; its bucket names it (loanReconBuckets.ts), its flags
 * and mismatches say why it needs a person, and its sentence says it in words. Sections: "Accepted, then undone" (the three undone buckets),
 * "Needs attention" (everything a person must look at), "Mismatches" (amount, currency, date, the partner's document); a row may sit in two.
 * With the partner withheld a row has no bucket and only its own-side flags and mismatches ((l).3).
 */
import { ATTENTION_BUCKETS, UNDONE_BUCKETS, bucketOf, contributionCents } from './loanReconBuckets';
import {
  PENDING_TOO_LONG_DAYS, type AttentionFlag, type Bucket, type ItemKind, type MessageFacts, type MismatchKey, type OwnDocuments,
  type PayloadDisplay, type ReconItem, type SectionKey,
} from './loanReconTypes';

export const BUCKET_SENTENCES: Record<Bucket, string> = {
  matched: 'Cleared on both sides.',
  in_flight: 'Your side or the partner\'s is cleared; the other has not accepted it yet.',
  rejected_or_dismissed: 'The receiver rejected or dismissed it while the payer\'s loan credit stands.',
  receiver_undone: 'The receiver cancelled its clearing receipt; the payer\'s side still stands.',
  payer_undone: 'The payer\'s side no longer stands; the receiver\'s clearing still does.',
  both_undone: 'Both sides were undone: it nets to nothing.',
  not_through_loan: 'The payment did not go through the payer\'s loan account.',
  not_live: 'The payer\'s side no longer stands and nothing was cleared.',
  withdrawn: 'Marked withdrawn: allocation messages are never withdrawn by the app.',
  anomaly: 'The receiver\'s clearing stands without a matching payer clearing: the guards should prevent this.',
  loan_account_changed: 'A loan account was changed after this was cleared: the figures cover the current account only.',
  payer_timing: 'A journal of the payer\'s side is dated after today.',
  timing: 'A journal of the receiver\'s clearing is dated after today.',
};

export const FLAG_SENTENCES: Record<AttentionFlag, string> = {
  failed: 'The receiver could not clear it.',
  pending_too_long: `Waiting for more than ${PENDING_TOO_LONG_DAYS} days.`,
  unsent: 'Paid against a linked bill, but no message was sent to the partner.',
  unlinked_partner_bill: 'A paid bill from the partner that is not linked to its invoice.',
};

/** Which sections a row is listed in. */
export function sectionsOf(r: { kind: ItemKind; bucket: Bucket | null; flags: AttentionFlag[]; mismatches: MismatchKey[] }): SectionKey[] {
  const out: SectionKey[] = [];
  if (r.bucket && UNDONE_BUCKETS.has(r.bucket)) out.push('undone');
  if (r.kind !== 'message' || (r.bucket && ATTENTION_BUCKETS.has(r.bucket)) || r.flags.length > 0) out.push('attention');
  if (r.mismatches.length > 0) out.push('mismatch');
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null);
const day = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : null);

export const NO_DOCUMENTS: OwnDocuments = {
  billId: null, billNumber: null, paymentId: null, paymentNumber: null, paymentStatus: null, invoiceId: null, invoiceNumber: null, receiptId: null, receiptNumber: null,
};
const NO_DISPLAY: PayloadDisplay = { paymentNumber: null, paymentDate: null, reference: null, payerDocumentNumber: null, currency: null };

/** One message row as the reads return it. */
export interface MessageRow extends MessageFacts {
  id: string;
  createdAt: unknown;
  ageDays: number;
  error: unknown;
  display: PayloadDisplay;
  own: OwnDocuments;
}

/** A message row's item, with its bucket and contribution judged; `cutover` is the pair's (the date mismatch). */
export function messageItem(r: MessageRow, cutover: string | null): ReconItem {
  const bucket = bucketOf(r);
  const contribution = contributionCents(r);
  const flags: AttentionFlag[] = [];
  if (r.status === 'failed') flags.push('failed');
  if ((r.status === 'pending' || r.status === 'failed') && r.ageDays > PENDING_TOO_LONG_DAYS) flags.push('pending_too_long');
  const mismatches: MismatchKey[] = [];
  if (r.amount === null || r.payerState === 'changed' || r.payerJournalDiffers === true) mismatches.push('amount');
  if ((r.display.currency ?? 'ZAR').toUpperCase() !== 'ZAR') mismatches.push('currency');
  const paidBefore = cutover !== null && r.display.paymentDate !== null && r.display.paymentDate < cutover;
  if (paidBefore || r.payerAfterT === true || r.receiverAfterT === true) mismatches.push('date');
  // the receiver's invoice matters while the message is still to be handled: once cleared, a paid invoice is the expected end
  if (r.direction === 'out' && r.partnerDocument !== null && r.partnerDocument !== 'open' && ['pending', 'failed', 'dismissed'].includes(r.status)) {
    mismatches.push('partner_document');
  }
  const sentence = bucket ? BUCKET_SENTENCES[bucket] : flags.length ? FLAG_SENTENCES[flags[0]!] : 'The partner\'s side is withheld.';
  return {
    kind: 'message', id: r.id, createdAt: iso(r.createdAt), direction: r.direction, status: r.status, bucket, amount: r.amount ?? 0,
    contribution: contribution === null ? null : contribution / 100, payerState: r.payerState, receiverState: r.receiverState,
    partnerDocument: r.partnerDocument, payerJournalDiffers: r.payerJournalDiffers, flags, mismatches, error: str(r.error), sentence,
    display: r.display, own: r.own, cutover,
  };
}

/** S as payer: a processed / reconciled payment applied to a linked bill with no allocation message: S's own facts only. */
export function unsentItem(r: Record<string, unknown>, cutover: string | null): ReconItem {
  return {
    kind: 'unsent', id: String(r.allocation_id), createdAt: iso(r.created_at), direction: 'out', status: null, bucket: null,
    amount: Number(r.amount ?? 0), contribution: null, payerState: null, receiverState: null, partnerDocument: null, payerJournalDiffers: null,
    flags: ['unsent'], mismatches: [], error: null, sentence: FLAG_SENTENCES.unsent,
    display: { ...NO_DISPLAY, paymentNumber: str(r.payment_number), paymentDate: day(r.payment_date), reference: str(r.reference) },
    own: { ...NO_DOCUMENTS, billId: str(r.bill_id), billNumber: str(r.bill_number), paymentId: str(r.payment_id), paymentNumber: str(r.payment_number), paymentStatus: str(r.payment_status) },
    cutover,
  };
}

/** S as payer: a paid bill of the side's supplier on or after the pair cut-over that holds no live link on this connection. */
export function unlinkedItem(r: Record<string, unknown>, cutover: string | null): ReconItem {
  return {
    kind: 'unlinked_bill', id: String(r.bill_id), createdAt: iso(r.created_at), direction: 'out', status: null, bucket: null,
    amount: Number(r.amount_paid ?? 0), contribution: null, payerState: null, receiverState: null, partnerDocument: null, payerJournalDiffers: null,
    flags: ['unlinked_partner_bill'], mismatches: [], error: null, sentence: FLAG_SENTENCES.unlinked_partner_bill,
    display: { ...NO_DISPLAY, paymentDate: day(r.bill_date) },
    own: { ...NO_DOCUMENTS, billId: str(r.bill_id), billNumber: str(r.bill_number) },
    cutover,
  };
}
