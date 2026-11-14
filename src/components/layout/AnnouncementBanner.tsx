// src/components/layout/AnnouncementBanner.tsx
//
// The platform's announcements (maintenance windows, new features, warnings) as bars at the top of the tenant app.
// Plain text only: title and message are React text children, never HTML. A dismissible one has a close button
// that is remembered per user on the server, so it stays closed on every device; a not-dismissible one has none.
// If the server cannot keep a dismissal the bar stays and says why.
//
// AppLayout mounts afresh on every client-side navigation, so the last answer is kept for a few minutes per user
// and company: a second page shows the bars in its first frame instead of pushing the content down when a fetch
// lands, and the server is asked once per window, not once per click.

import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { TenantAnnouncement } from '@/lib/tenantAnnouncements';

const CACHE_MS = 5 * 60 * 1000;
const TONE: Record<TenantAnnouncement['type'], string> = {
  info:        'bg-blue-50 text-blue-900 border-blue-200 dark:bg-blue-950 dark:text-blue-100 dark:border-blue-800',
  warning:     'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800',
  maintenance: 'bg-orange-50 text-orange-900 border-orange-200 dark:bg-orange-950 dark:text-orange-100 dark:border-orange-800',
  feature:     'bg-teal-50 text-teal-900 border-teal-200 dark:bg-teal-950 dark:text-teal-100 dark:border-teal-800',
};

interface Cached { key: string; at: number; items: TenantAnnouncement[] }
let cache: Cached | null = null;

/** Forget the kept answer (tests; sign-out is a full page load, which drops it anyway). */
export function clearAnnouncementCache(): void { cache = null; }

function fresh(key: string): TenantAnnouncement[] | null {
  return cache && cache.key === key && Date.now() - cache.at < CACHE_MS ? cache.items : null;
}

export function AnnouncementBanner() {
  const { user } = useAuth();
  const { activeCompany } = useCompany();
  const userId = user?.id;
  const companyId = activeCompany?.id;
  const key = userId && companyId ? `${userId}:${companyId}` : '';
  const [items, setItems] = useState<TenantAnnouncement[]>(() => (key ? fresh(key) ?? [] : []));

  useEffect(() => {
    if (!key) { setItems([]); return; }
    const kept = fresh(key);
    if (kept) { setItems(kept); return; }
    let cancelled = false;
    apiJson('/api/announcements/active', undefined, 'Could not load announcements')
      .then((list) => {
        cache = { key, at: Date.now(), items: list };
        if (!cancelled) setItems(list);
      })
      .catch((err: unknown) => {
        // A banner must never get in the way of the app: say nothing, log it.
        log.warn('Could not load announcements', { message: apiErrorMessage(err, 'unknown') }, 'announcement-banner');
        if (!cancelled) setItems([]);
      });
    return () => { cancelled = true; };
  }, [key]);

  const [failed, setFailed] = useState<Record<string, string>>({});
  const dismiss = useCallback(async (id: string) => {
    setFailed((f) => ({ ...f, [id]: '' }));
    try {
      await apiJson('/api/announcements/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }, 'Could not dismiss this announcement - try again');
      setItems((list) => list.filter((a) => a.id !== id));
      if (cache) cache = { ...cache, items: cache.items.filter((a) => a.id !== id) };
    } catch (err) {
      // Kept on screen, with the reason: a Login-as session is refused, and a dropped connection can be retried.
      setFailed((f) => ({ ...f, [id]: apiErrorMessage(err, 'Could not dismiss this announcement - try again') }));
    }
  }, []);

  if (items.length === 0) return null;

  return (
    <div data-testid="announcement-banner" className="w-full shrink-0">
      {items.map((a) => (
        <div key={a.id} role="status"
          className={`flex items-start gap-3 border-b px-4 py-2 text-sm ${TONE[a.type] ?? TONE.info}`}>
          <p className="min-w-0 flex-1 whitespace-pre-line break-words">
            <strong className="font-semibold">{a.title}</strong>
            {' '}
            <span>{a.message}</span>
          </p>
          {failed[a.id] && <span role="alert" className="shrink-0 text-xs font-medium">{failed[a.id]}</span>}
          {a.is_dismissible && (
            <button type="button" onClick={() => { void dismiss(a.id); }} aria-label={`Dismiss announcement: ${a.title}`}
              className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-current">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
