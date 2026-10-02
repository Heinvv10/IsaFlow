/**
 * Table of VAT period locks — active locks first, then unlocked history.
 * Each active row gets an inline unlock control; history rows are read-only.
 */
import { useState } from 'react';
import { Lock, Unlock, Loader2 } from 'lucide-react';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { VatPeriodLock } from './vatPeriodLockTypes';

interface Props {
  locks: VatPeriodLock[];
  onUnlock: (lockId: string, reason: string) => Promise<string | null>;
}

export function VatPeriodLocksTable({ locks, onUnlock }: Props) {
  const [openConfirmId, setOpenConfirmId] = useState<string | null>(null);

  if (locks.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-6 text-center text-sm text-[var(--ff-text-secondary)]">
        No VAT periods have been locked yet.
      </div>
    );
  }

  const sorted = [...locks].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.periodStart.localeCompare(a.periodStart);
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
            <th className="px-4 py-3">Period</th>
            <th className="px-4 py-3">Output VAT</th>
            <th className="px-4 py-3">Input VAT</th>
            <th className="px-4 py-3">Net VAT</th>
            <th className="px-4 py-3">Locked by / at</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Notes</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((lock) => (
            <LockRow
              key={lock.id}
              lock={lock}
              confirming={openConfirmId === lock.id}
              onOpenConfirm={() => setOpenConfirmId(lock.id)}
              onCloseConfirm={() => setOpenConfirmId(null)}
              onUnlock={onUnlock}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LockRow({
  lock, confirming, onOpenConfirm, onCloseConfirm, onUnlock,
}: {
  lock: VatPeriodLock;
  confirming: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  onUnlock: (lockId: string, reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!reason.trim()) { setError('A reason is required to unlock a VAT period'); return; }
    setSubmitting(true); setError('');
    let err: string | null;
    try { err = await onUnlock(lock.id, reason.trim()); } finally { setSubmitting(false); }
    if (err) { setError(err); return; }
    setReason(''); onCloseConfirm();
  };

  return (
    <>
      <tr className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
        <td className="px-4 py-3 text-[var(--ff-text-primary)]">
          {formatDate(lock.periodStart)} – {formatDate(lock.periodEnd)}
        </td>
        <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatCurrency(lock.outputTax)}</td>
        <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatCurrency(lock.inputTax)}</td>
        <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">{formatCurrency(lock.netVat)}</td>
        <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
          {lock.lockedByName} · {formatDate(lock.lockedAt)}
        </td>
        <td className="px-4 py-3">
          {lock.active ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400">
              <Lock className="h-3 w-3" /> Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">
              <Unlock className="h-3 w-3" />
              Unlocked on {formatDate(lock.unlockedAt)} by {lock.unlockedByName}: {lock.unlockReason}
            </span>
          )}
        </td>
        <td className="px-4 py-3 max-w-xs truncate text-[var(--ff-text-secondary)]" title={lock.notes ?? undefined}>
          {lock.notes || '—'}
        </td>
        <td className="px-4 py-3 text-right">
          {lock.active && !confirming && (
            <button
              onClick={onOpenConfirm}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ff-border-light)] px-3 py-1.5 text-xs text-[var(--ff-text-secondary)] hover:border-red-500/30 hover:text-red-400"
            >
              <Unlock className="h-3.5 w-3.5" /> Unlock
            </button>
          )}
        </td>
      </tr>
      {confirming && (
        <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/40">
          <td colSpan={8} className="px-4 py-4">
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
              <p className="text-sm font-medium text-red-400">
                Unlocking this period lets postings change a filed VAT201. This should only be done to correct
                a genuine error before amending the return.
              </p>
              {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
              <label htmlFor={`vat-unlock-reason-${lock.id}`} className="mt-3 block text-xs font-medium text-[var(--ff-text-secondary)]">
                Reason (required)
              </label>
              <textarea
                id={`vat-unlock-reason-${lock.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]"
                placeholder="Why is this period being unlocked?"
              />
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => void submit()}
                  disabled={submitting || reason.trim() === ''}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                  Confirm unlock
                </button>
                <button
                  onClick={() => { onCloseConfirm(); setReason(''); setError(''); }}
                  className="rounded-lg px-3 py-1.5 text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
