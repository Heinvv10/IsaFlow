/**
 * The SARS overview's deadlines table: overdue, due in the next 90 days, and items a user marked
 * filed (POST/DELETE /api/accounting/sars/compliance-filed). A mark is the user's record that the
 * return was filed with SARS, not a check against SARS: it reads "Marked filed", never "Submitted".
 */
import { useRef, useState } from 'react';
import { Calendar, CheckCircle2, Undo2 } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import { formatDate } from '@/utils/formatters';
import { log } from '@/lib/logger';
import { statusBadge, daysUntil } from './sarsStatusBadge';

export interface CalendarItem {
  id?: string;
  eventType: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  description: string;
  status: 'pending' | 'completed' | 'overdue';
  filedBy?: string | null;
  filedAt?: string;
  sarsReference?: string | null;
}

interface Props {
  events: CalendarItem[];
  /** The marks could not be read: say so, since a filed item then shows as overdue. */
  marksUnavailable?: boolean;
  /** Reload the calendar (after a mark, an undo, or a refusal that means the row is stale). */
  onChanged: () => void;
}

export function ComplianceCalendarTable({ events, marksUnavailable = false, onChanged }: Props) {
  const { companyRole } = useCompany();
  const writer = canWrite(companyRole);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  // One request at a time: every action is disabled while one is in flight.
  // The ref is the guard (a second click in the same tick sees it at once); the state disables the buttons.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Overdue, due in the next 90 days, and marked filed (so a mark can be undone).
  const rows = events.filter((e) => daysUntil(e.dueDate) <= 90);
  const keyOf = (e: CalendarItem) => `${e.eventType}_${e.periodEnd}`;

  const send = async (e: CalendarItem, method: 'POST' | 'DELETE') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const body = method === 'POST'
        ? { eventType: e.eventType, periodEnd: e.periodEnd, sarsReference: reference.trim() || null }
        : { eventType: e.eventType, periodEnd: e.periodEnd };
      const res = await apiFetch('/api/accounting/sars/compliance-filed', { method, body: JSON.stringify(body) });
      // 409 (already marked) and 404 (no longer marked): the row on screen is stale. Reload it; the message stays.
      if (res.status === 409 || res.status === 404) onChanged();
      await assertOk(res, method === 'POST' ? 'Could not mark this return filed' : 'Could not undo the mark');
      setOpenKey(null);
      setReference('');
      onChanged();
    } catch (err) {
      log.warn('ComplianceCalendarTable: mark change failed', { error: err, method }, 'ComplianceCalendarTable');
      setError(apiErrorMessage(err, method === 'POST' ? 'Could not mark this return filed' : 'Could not undo the mark'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
          <Calendar className="h-5 w-5 text-teal-500" />
          Upcoming Deadlines
        </h2>
      </div>
      {marksUnavailable && (
        <div className="mx-4 mt-3 p-2 rounded bg-amber-500/10 text-amber-500 text-sm" role="status">
          Filed marks could not be loaded. Items marked filed may show as overdue - reload to try again.
        </div>
      )}
      {error && <div className="mx-4 mt-3 p-2 rounded bg-red-500/10 text-red-400 text-sm" role="alert">{error}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3">Due Date</th>
              <th className="px-4 py-3">Days</th>
              <th className="px-4 py-3">Status</th>
              {writer && <th className="px-4 py-3"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={writer ? 6 : 5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                  No upcoming deadlines in the next 90 days.
                </td>
              </tr>
            )}
            {rows.map((evt) => {
              const days = daysUntil(evt.dueDate);
              const k = keyOf(evt);
              const filed = evt.status === 'completed';
              return (
                <tr key={k} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 align-top">
                  <td className="px-4 py-3">
                    <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400">
                      {evt.eventType.replace('_DUE', '').replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-primary)]">{evt.description}</td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatDate(evt.dueDate)}</td>
                  <td className="px-4 py-3">
                    {filed ? <span className="text-[var(--ff-text-tertiary)]">-</span> : (
                      <span className={`font-medium ${days < 0 ? 'text-red-400' : days <= 14 ? 'text-amber-400' : 'text-[var(--ff-text-secondary)]'}`}>
                        {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today' : `${days}d`}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {statusBadge(evt.status)}
                    {filed && evt.filedAt && (
                      <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">
                        {`by ${evt.filedBy || 'a team member'} on ${formatDate(evt.filedAt)}`}
                        {evt.sarsReference ? ` · Ref ${evt.sarsReference}` : ''}
                      </p>
                    )}
                  </td>
                  {writer && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {filed ? (
                        <button type="button" disabled={busy} onClick={() => void send(evt, 'DELETE')}
                          className="inline-flex items-center gap-1 text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50">
                          <Undo2 className="h-3.5 w-3.5" /> Undo
                        </button>
                      ) : openKey === k ? (
                        <form className="flex items-center gap-2 justify-end" onSubmit={(ev) => { ev.preventDefault(); void send(evt, 'POST'); }}>
                          <input aria-label="SARS reference (optional)" placeholder="SARS reference (optional)" maxLength={100}
                            value={reference} onChange={(ev) => setReference(ev.target.value)}
                            className="w-44 px-2 py-1 text-xs rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]" />
                          <button type="submit" disabled={busy}
                            className="px-2 py-1 text-xs rounded bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50">Save</button>
                          <button type="button" onClick={() => { setOpenKey(null); setReference(''); }}
                            className="px-2 py-1 text-xs text-[var(--ff-text-secondary)]">Cancel</button>
                        </form>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => { setOpenKey(k); setReference(''); setError(''); }}
                          className="inline-flex items-center gap-1 text-xs text-teal-500 hover:text-teal-400 disabled:opacity-50">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Mark filed
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
