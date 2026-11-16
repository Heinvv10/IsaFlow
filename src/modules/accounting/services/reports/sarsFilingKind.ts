/**
 * How a SARS submission (sars_submissions) was filed, and its one label, shared by every surface
 * (calendar, Recent Filings, Filings page, detail modal) so none can claim eFiling for a filing
 * IsaFlow did not send.
 *   efiled      efiling_channel 'isv' (set only by IsaFlow's own send) and 'accepted' (SARS's final verdict)
 *   processing  'isv' and still 'submitted': SARS received it and has not ruled (it may still reject)
 *   recorded    no channel: markSubmitted wrote it (the legacy "mark submitted" or the return
 *               lifecycle's file, both with a user-typed reference). A user's claim, never eFiling.
 * Any other status (draft, rejected, superseded) is not a filing: null.
 */
export type FilingKind = 'efiled' | 'processing' | 'recorded';

export const FILING_KIND_LABEL: Readonly<Record<FilingKind, string>> = {
  efiled: 'Filed on eFiling',
  processing: 'Sent to SARS (processing)',
  recorded: 'Marked submitted',
};

export function filingKindOf(status: string, channel: string | null | undefined): FilingKind | null {
  if (status !== 'submitted' && status !== 'accepted') return null;
  if (channel !== 'isv') return 'recorded';
  return status === 'accepted' ? 'efiled' : 'processing';
}
