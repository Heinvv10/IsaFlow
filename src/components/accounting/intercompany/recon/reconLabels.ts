/** Words of the loan reconciliation page (P5): bucket names, the Unexplained parts, the tabs and their empty states. */
import type { Bucket, SectionKey } from '@/modules/accounting/services/intercompany/loanReconTypes';

export const BUCKET_LABELS: Record<Bucket, string> = {
  matched: 'Matched', in_flight: 'In flight', rejected_or_dismissed: 'Rejected or dismissed', receiver_undone: 'Receiver undone',
  payer_undone: 'Payer undone', both_undone: 'Both undone', not_through_loan: 'Not through the loan account', not_live: 'No longer live',
  withdrawn: 'Withdrawn', anomaly: 'Anomaly', loan_account_changed: 'Loan account changed', payer_timing: 'Payer dated after today',
  timing: 'Receiver dated after today',
};

export const PART_LABELS = {
  ownOther: 'Other postings, your account',
  partnerOther: "Other postings, the partner's account",
  residualOwn: 'Journals that differ from their messages, your side',
  residualPartner: "Journals that differ from their messages, the partner's side",
} as const;

export const SECTION_LABELS: Record<SectionKey, string> = { undone: 'Accepted, then undone', attention: 'Needs attention', mismatch: 'Mismatches' };

export const SECTION_EMPTY: Record<SectionKey, string> = {
  undone: 'No accepted payment was undone on either side.',
  attention: 'Nothing needs attention.',
  mismatch: 'No mismatches.',
};

export const MISMATCH_LABELS = { amount: 'Amount', currency: 'Currency', date: 'Date', partner_document: "Partner's invoice" } as const;

/** A timestamp as Johannesburg time (24 Nov 2026 12:15), whatever the browser's zone. */
export function formatReadAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}
