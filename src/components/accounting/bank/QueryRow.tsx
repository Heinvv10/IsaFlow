/**
 * QueryRow sub-components for the Client Queries resolution queue page.
 * Extracted to keep queries.tsx within the 300-line cap.
 */

import { useState } from 'react';
import { ChevronDown, ChevronUp, Paperclip, CheckCircle2, X, Loader2 } from 'lucide-react';

// ── Types (subset shared with the page) ──────────────────────────────────────

export interface BankTxQueryRow {
  id: string;
  bank_transaction_id: string;
  to_number: string;
  message_body: string;
  status: 'sent' | 'replied' | 'resolved' | 'cancelled';
  reply_text: string | null;
  sent_at: string | null;
  replied_at: string | null;
  resolved_at: string | null;
  transaction_date: string | null;
  tx_description: string | null;
  amount: number;
  tx_status: string | null;
  bank_account_name: string | null;
  attachment_count: number;
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: BankTxQueryRow['status'] }) {
  const cls: Record<string, string> = {
    sent: 'bg-amber-900/40 text-amber-300 border-amber-700/40',
    replied: 'bg-teal-900/40 text-teal-300 border-teal-700/40',
    resolved: 'bg-neutral-800 text-neutral-400 border-neutral-700/40',
    cancelled: 'bg-zinc-800/60 text-zinc-500 border-zinc-700/40',
  };
  const label: Record<string, string> = {
    sent: 'Sent', replied: 'Replied', resolved: 'Resolved', cancelled: 'Cancelled',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${cls[status] ?? cls.cancelled}`}>
      {label[status] ?? status}
    </span>
  );
}

// ── ExpandableText ────────────────────────────────────────────────────────────

export function ExpandableText({ text, limit = 150, label = 'Show' }: { text: string; limit?: number; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= limit) {
    return <span className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap">{text}</span>;
  }
  return (
    <span>
      <span className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap">
        {expanded ? text : `${text.slice(0, limit)}…`}
      </span>
      <button
        onClick={() => setExpanded(e => !e)}
        className="ml-1 text-xs text-blue-400 hover:underline inline-flex items-center gap-0.5"
      >
        {expanded
          ? <><ChevronUp className="h-3 w-3" />Hide</>
          : <><ChevronDown className="h-3 w-3" />{label}</>}
      </button>
    </span>
  );
}

// ── QueryRowActions ───────────────────────────────────────────────────────────

interface RowActionsProps {
  row: BankTxQueryRow;
  acting: string | null;
  onViewSlips: (txId: string, desc: string | undefined) => void;
  onResolve: (id: string) => void;
  onCancel: (id: string, desc: string | null) => void;
}

export function QueryRowActions({ row, acting, onViewSlips, onResolve, onCancel }: RowActionsProps) {
  const busy = acting === row.id;
  return (
    <div className="flex items-start gap-1.5 flex-col">
      {row.attachment_count > 0 && (
        <button
          onClick={() => onViewSlips(row.bank_transaction_id, row.tx_description ?? undefined)}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors whitespace-nowrap"
        >
          <Paperclip className="h-3.5 w-3.5" />View slips ({row.attachment_count})
        </button>
      )}
      {(row.status === 'sent' || row.status === 'replied') && (
        <button
          onClick={() => onResolve(row.id)}
          disabled={busy}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {busy
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <CheckCircle2 className="h-3.5 w-3.5" />}
          Resolve
        </button>
      )}
      {row.status === 'sent' && (
        <button
          onClick={() => onCancel(row.id, row.tx_description)}
          disabled={busy}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          <X className="h-3.5 w-3.5" />Cancel
        </button>
      )}
    </div>
  );
}
