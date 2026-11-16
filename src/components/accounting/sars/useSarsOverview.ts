/**
 * The SARS overview page's data: the compliance calendar (with "marked filed" overlaid) and the
 * recent filings. `refresh` reloads without the page spinner (after a mark or undo), and only the
 * newest load writes state, so a slow earlier response can never overwrite a newer one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import type { CalendarItem } from './ComplianceCalendarTable';
import { daysUntil } from './sarsStatusBadge';

export interface SarsSubmissionRow {
  id: string;
  formType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  submissionReference: string | null;
  submittedAt: string | null;
  createdAt: string;
}

/** The summary cards: overdue (never a marked item), due in the next 90 days, and marked filed. */
export function calendarCounts(events: CalendarItem[]): { overdue: number; pending: number; completed: number } {
  return {
    overdue: events.filter((e) => e.status === 'overdue').length,
    pending: events.filter((e) => e.status === 'pending' && daysUntil(e.dueDate) <= 90).length,
    completed: events.filter((e) => e.status === 'completed').length,
  };
}

const LOAD_FAILED = 'Could not load the SARS data - try again';

export function useSarsOverview() {
  const [events, setEvents] = useState<CalendarItem[]>([]);
  const [submissions, setSubmissions] = useState<SarsSubmissionRow[]>([]);
  const [marksUnavailable, setMarksUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const id = ++latest.current;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const [compRes, subRes] = await Promise.all([
        apiFetch('/api/accounting/sars/sars-compliance', { credentials: 'include' }),
        apiFetch('/api/accounting/sars/sars-submissions', { credentials: 'include' }),
      ]);
      await assertOk(compRes, LOAD_FAILED); await assertOk(subRes, LOAD_FAILED);
      const [compJson, subJson] = await Promise.all([compRes.json(), subRes.json()]);
      if (id !== latest.current) return;
      setEvents(compJson.data?.events || []);
      setMarksUnavailable(compJson.data?.marksUnavailable === true);
      setSubmissions(subJson.data?.items || []);
    } catch (err) {
      if (id !== latest.current) return;
      setEvents([]); setSubmissions([]); setError(apiErrorMessage(err, LOAD_FAILED));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(() => { void load(true); }, [load]);
  return { events, submissions, marksUnavailable, loading, error, refresh };
}
