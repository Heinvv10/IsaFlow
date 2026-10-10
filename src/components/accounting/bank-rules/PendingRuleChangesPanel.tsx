/**
 * "Pending changes" above the bank-rules table (forensic-controls step 2):
 * every change held under the `bank_rule` switch — pending creations
 * included, which have no row yet — with what moves (before → after), who
 * proposed it and when. Approve / Reject (with an optional note) only where
 * the server says this viewer may decide it; the POST decides regardless.
 */
import { useState } from 'react';
import { Check, Clock, Loader2, X } from 'lucide-react';
import type { PendingRuleChange } from './useBankRuleChanges';

const KIND: Record<PendingRuleChange['kind'], string> = { create: 'New rule', update: 'Edit', toggle: 'Re-activate' };
const LABELS: Record<string, string> = {
  rule_name: 'Name', match_field: 'Match field', match_type: 'Match type', match_pattern: 'Pattern',
  gl_account_id: 'GL account', supplier_id: 'Supplier', client_id: 'Customer', description_template: 'Description',
  priority: 'Priority', is_active: 'Active', auto_create_entry: 'Auto-post', vat_code: 'VAT', auto_apply: 'Apply cash',
};

/** A value as a person reads it: accounts, suppliers and customers by name (`names`, id → label) rather than id. */
const show = (v: unknown, names: Record<string, string>) => (v === null || v === undefined || v === '' ? '—'
  : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : names[String(v)] ?? String(v));
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
};

interface Props {
  changes: PendingRuleChange[];
  error: string;
  busyId: string;
  /** Account, supplier and customer labels by id. */
  names: Record<string, string>;
  onDecide: (change: PendingRuleChange, action: 'approve' | 'reject', note: string) => Promise<boolean>;
}

function ChangeItem({ change, busy, names, onDecide }: {
  change: PendingRuleChange; busy: boolean; names: Record<string, string>; onDecide: Props['onDecide'];
}) {
  const [note, setNote] = useState('');
  // A creation lists its whole rule; an edit only what moves.
  const shown = change.kind === 'create'
    ? change.changes.filter((c) => c.after !== null && c.after !== false && LABELS[c.key])
    : change.changes;
  return (
    <li className="py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400">{KIND[change.kind]}</span>
        <span className="font-medium text-[var(--ff-text-primary)]">{change.ruleName}</span>
        <span className="text-xs text-[var(--ff-text-tertiary)]">
          proposed by {change.proposerName ?? 'an unknown member'} · {when(change.proposedAt)}
        </span>
      </div>
      <ul className="text-xs text-[var(--ff-text-secondary)] space-y-0.5">
        {shown.map((c) => (
          <li key={c.key}>
            <span className="text-[var(--ff-text-tertiary)]">{LABELS[c.key] ?? c.key}:</span>{' '}
            {change.kind === 'create' ? show(c.after, names)
              : <>{show(c.before, names)} → <span className="text-[var(--ff-text-primary)]">{show(c.after, names)}</span></>}
          </li>
        ))}
      </ul>
      {change.canDecide ? (
        <div className="flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)"
            aria-label={`Note on the change to ${change.ruleName}`} className="ff-input text-xs flex-1 min-w-[12rem]" />
          <button type="button" disabled={busy} onClick={() => void onDecide(change, 'approve', note)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-teal-600 text-white text-xs disabled:opacity-50">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Approve
          </button>
          <button type="button" disabled={busy} onClick={() => void onDecide(change, 'reject', note)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-red-500/40 text-red-400 text-xs disabled:opacity-50">
            <X className="h-3 w-3" /> Reject
          </button>
        </div>
      ) : (
        <p className="text-xs text-[var(--ff-text-tertiary)]">Waiting for another member with the approver role to decide.</p>
      )}
    </li>
  );
}

export function PendingRuleChangesPanel({ changes, error, busyId, names, onDecide }: Props) {
  if (error) return <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>;
  if (changes.length === 0) return null;
  return (
    <section aria-label="Pending rule changes" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-amber-300 pt-1">
        <Clock className="h-4 w-4" /> Pending changes ({changes.length}) — these post money once approved
      </h2>
      <ul className="divide-y divide-[var(--ff-border-light)]">
        {changes.map((c) => <ChangeItem key={c.id} change={c} busy={busyId === c.id} names={names} onDecide={onDecide} />)}
      </ul>
    </section>
  );
}
