/**
 * LoanEventsTab — event log table + inline add-event form.
 */

import { useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { LoanEvent, fmtDate, fmt } from './types';

interface Props {
  loanId: string;
  events: LoanEvent[];
  onRefresh: () => void;
}

const KIND_OPTIONS = ['LUMP', 'SKIP', 'RESTRUCTURE'];

interface EventForm {
  kind: string;
  date: string;
  amount: string;
  note: string;
}

const EMPTY_FORM: EventForm = { kind: 'LUMP', date: '', amount: '', note: '' };

export function LoanEventsTab({ loanId, events, onRefresh }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<EventForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        kind: form.kind,
        date: form.date,
        note: form.note || null,
      };
      if (form.kind === 'LUMP') body.amount = Number(form.amount);
      const res = await apiFetch(`/api/accounting/loans/${loanId}/events`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to add event');
      setForm(EMPTY_FORM);
      setShowForm(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add event');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide">
          Event Log
        </h3>
        <button
          onClick={() => setShowForm(s => !s)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-xs font-medium"
        >
          <Plus className="h-3.5 w-3.5" /> Add Event
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-primary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-3">
          <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">New Event</h4>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={form.kind}
              onChange={e => setForm(f => ({ ...f, kind: e.target.value }))}
              className="ff-select text-sm"
            >
              {KIND_OPTIONS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="ff-input text-sm"
              required
            />
            {form.kind === 'LUMP' && (
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="Amount (ZAR)"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                className="ff-input text-sm"
                required
              />
            )}
            <input
              type="text"
              placeholder="Note (optional)"
              value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
              className="ff-input text-sm col-span-2"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
              className="px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-teal-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save Event'}
            </button>
          </div>
        </form>
      )}

      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Note</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                  No events recorded.
                </td>
              </tr>
            )}
            {events.map(ev => (
              <tr key={ev.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                <td className="px-4 py-3 text-[var(--ff-text-primary)]">{fmtDate(ev.date)}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    ev.kind === 'LUMP' ? 'bg-blue-500/10 text-blue-400' :
                    ev.kind === 'SKIP' ? 'bg-amber-500/10 text-amber-400' :
                    'bg-purple-500/10 text-purple-400'
                  }`}>
                    {ev.kind}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
                  {ev.amount != null ? fmt(ev.amount) : '—'}
                </td>
                <td className="px-4 py-3 text-[var(--ff-text-secondary)] truncate max-w-[240px]">
                  {ev.note || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
