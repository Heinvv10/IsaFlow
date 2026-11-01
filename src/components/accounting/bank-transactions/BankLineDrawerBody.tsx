/**
 * The bank line drawer: one line of the grid with what the grid has no room for, its attachments and the journal it
 * is matched to. Read-only. That journal is not always the line's own bank leg: a hand match names any journal line,
 * so this shows the journal as it stands and does not call any of its lines the contra.
 */

import Link from 'next/link';
import { StatusPill } from '@/components/ui';
import { useDrawerRead } from '@/components/ui/useDrawerRead';
import type { BankTx } from '@/components/accounting/BankTxTable';
import { SAFE_HREF, type Attachment } from '@/components/accounting/bankTxAttachmentHelpers';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

interface MatchedJournal {
  id: string;
  entryNumber: string;
  entryDate: string;
  status: string;
  lines: { id: string; accountCode?: string; accountName?: string; debit: number; credit: number }[];
}

const MUTED = 'text-sm text-[var(--ff-text-secondary)]';
const FAILED = 'text-sm text-red-600 dark:text-red-400';
const HEADING = 'mb-1 text-sm font-semibold text-[var(--ff-text-primary)]';
const LINK = 'text-sm font-medium text-teal-700 hover:underline dark:text-teal-300';

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="shrink-0 text-[var(--ff-text-secondary)]">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[var(--ff-text-primary)]">{value}</dd>
    </div>
  );
}

function Attachments({ txId }: { txId: string }) {
  const { data, error, loading } = useDrawerRead<Attachment[]>(
    `/api/accounting/bank-tx-attachments?bankTransactionId=${txId}`, 'Could not load the attachments - try again');
  if (loading) return <p className={MUTED}>Loading attachments…</p>;
  if (error || !data) return <p role="alert" className={FAILED}>{error}</p>;
  if (data.length === 0) return <p className={MUTED}>No attachments.</p>;
  return (
    <ul className="space-y-1">
      {data.map((a) => (
        <li key={a.id} className="break-words">
          {SAFE_HREF.test(a.file_url)
            ? <a href={a.file_url} target="_blank" rel="noopener noreferrer" download={a.file_name} className={LINK}>{a.file_name}</a>
            : <span className={MUTED}>{a.file_name}</span>}
        </li>
      ))}
    </ul>
  );
}

function Journal({ journalId }: { journalId: string }) {
  const { data, error, loading } = useDrawerRead<MatchedJournal>(
    `/api/accounting/journal-entries-detail?id=${journalId}`, 'Could not load the journal - try again');
  if (loading) return <p className={MUTED}>Loading journal…</p>;
  if (error || !data) return <p role="alert" className={FAILED}>{error}</p>;
  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <Link href={`/accounting/journal-entries/${data.id}`} className={LINK}>{data.entryNumber}</Link>
        <span className={MUTED}>{formatDisplayDate(data.entryDate)}</span>
        <StatusPill status={data.status} />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-xs text-[var(--ff-text-secondary)]">
            <th className="py-1 font-medium">Account</th>
            <th className="py-1 pl-2 text-right font-medium">Debit</th>
            <th className="py-1 pl-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.id} className="border-b border-[var(--ff-border-light)]/50 align-top text-[var(--ff-text-primary)]">
              <td className="break-words py-1.5">{[l.accountCode, l.accountName].filter(Boolean).join(' ')}</td>
              <td className="whitespace-nowrap py-1.5 pl-2 text-right tabular-nums">{l.debit ? formatMoney(l.debit) : ''}</td>
              <td className="whitespace-nowrap py-1.5 pl-2 text-right tabular-nums">{l.credit ? formatMoney(l.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function BankLineDrawerBody({ tx }: { tx: BankTx }) {
  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <p className="tabular-nums text-lg font-semibold text-[var(--ff-text-primary)]">{formatMoney(tx.amount)}</p>
          <StatusPill status={tx.status} />
        </div>
        <dl>
          <Field label="Date" value={formatDisplayDate(tx.transactionDate)} />
          <Field label="Description" value={tx.description} />
          <Field label="Reference" value={tx.reference} />
          <Field label="Bank reference" value={tx.bankReference} />
          <Field label="Allocated to" value={tx.allocatedEntityName} />
          <Field label="Notes" value={tx.notes} />
          {/* An undone exclude leaves excluded_reason on the row: it only means something while the line is excluded. */}
          {tx.status === 'excluded' && <Field label="Excluded because" value={tx.excludeReason} />}
        </dl>
      </div>
      <section>
        <h3 className={HEADING}>Attachments</h3>
        <Attachments txId={tx.id} />
      </section>
      <section>
        <h3 className={HEADING}>Matched journal</h3>
        {tx.matchedJournalEntryId ? <Journal journalId={tx.matchedJournalEntryId} /> : <p className={MUTED}>Not matched to a journal.</p>}
      </section>
    </div>
  );
}
