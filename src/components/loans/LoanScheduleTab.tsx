/**
 * LoanScheduleTab — schedule table + what-if side panel.
 */

import { useState } from 'react';
import { SlidersHorizontal, X, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ScheduleRow, LoanEvent } from './types';
import { LoanScheduleTable } from './LoanScheduleTable';

interface Props {
  loanId: string;
  rows: ScheduleRow[];
  loading: boolean;
}

interface WhatIfEvent {
  kind: string;
  date: string;
  amount: string;
}

export function LoanScheduleTab({ loanId, rows, loading }: Props) {
  const [showPanel, setShowPanel] = useState(false);
  const [previewRows, setPreviewRows] = useState<ScheduleRow[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [events, setEvents] = useState<WhatIfEvent[]>([
    { kind: 'LUMP', date: '', amount: '' },
  ]);

  const addEvent = () => setEvents(ev => [...ev, { kind: 'LUMP', date: '', amount: '' }]);
  const removeEvent = (i: number) => setEvents(ev => ev.filter((_, idx) => idx !== i));
  const updateEvent = (i: number, field: keyof WhatIfEvent, value: string) =>
    setEvents(ev => ev.map((e, idx) => idx === i ? { ...e, [field]: value } : e));

  const runPreview = async () => {
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const evPayload: Partial<LoanEvent>[] = events
        .filter(e => e.date)
        .map(e => ({
          kind: e.kind,
          date: e.date,
          amount: e.amount ? Number(e.amount) : null,
          note: 'what-if',
        }));
      const res = await apiFetch(`/api/accounting/loans/${loanId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ events: evPayload }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Preview failed');
      setPreviewRows(json.data?.rows ?? []);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const displayRows = previewRows ?? rows;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide">
          Amortisation Schedule
          {previewRows && (
            <span className="ml-2 px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-400 normal-case font-normal">
              What-If Preview
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {previewRows && (
            <button
              onClick={() => setPreviewRows(null)}
              className="px-3 py-1.5 text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)] rounded-lg"
            >
              Reset to Actual
            </button>
          )}
          <button
            onClick={() => setShowPanel(s => !s)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:text-[var(--ff-text-primary)] text-xs font-medium"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Preview What-If
          </button>
        </div>
      </div>

      {showPanel && (
        <div className="bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">What-If Events</h4>
            <button onClick={() => setShowPanel(false)} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {previewError && (
            <div className="p-2 rounded bg-red-500/10 text-red-400 text-xs">{previewError}</div>
          )}

          {events.map((ev, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
              <select
                value={ev.kind}
                onChange={e => updateEvent(i, 'kind', e.target.value)}
                className="ff-select text-xs"
              >
                <option value="LUMP">Lump Sum</option>
                <option value="SKIP">Skip</option>
              </select>
              <input
                type="date"
                value={ev.date}
                onChange={e => updateEvent(i, 'date', e.target.value)}
                className="ff-input text-xs"
              />
              {ev.kind === 'LUMP' ? (
                <input
                  type="number"
                  step="0.01"
                  placeholder="Amount"
                  value={ev.amount}
                  onChange={e => updateEvent(i, 'amount', e.target.value)}
                  className="ff-input text-xs"
                />
              ) : (
                <div />
              )}
              <button
                onClick={() => removeEvent(i)}
                className="text-[var(--ff-text-tertiary)] hover:text-red-400 p-1"
                disabled={events.length === 1}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <button
              onClick={addEvent}
              className="text-xs text-teal-400 hover:text-teal-300"
            >
              + Add another event
            </button>
            <button
              onClick={runPreview}
              disabled={previewLoading}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-1.5 bg-teal-600 text-white rounded-lg text-xs font-medium disabled:opacity-50"
            >
              {previewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Run Preview'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <LoanScheduleTable rows={displayRows} loading={loading} />
      </div>
    </div>
  );
}
