/**
 * NotificationBell — the header's in-app notifications (budgets P5 spec §5; store: migration 954
 * `user_notifications`). Unread count on the bell, a dropdown of the latest 20, mark one read (then
 * follow its in-app link) or all read. Not the setup guide (SetupGuideButton, a checklist count):
 * different icon (bell), label ("Notifications") and badge colour.
 *
 * The feed loads on mount and again each time the dropdown opens. Every call's status is checked
 * before its body is trusted; a failure is a sentence, never an empty list or a cleared badge.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Bell } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { isInAppPath } from '@/lib/inAppPath';
import { log } from '@/lib/logger';
import { cn } from '@/utils/cn';
import { formatDisplayDateTime } from '@/utils/dateFormat';
import type { NotificationFeed, UserNotification } from '@/modules/accounting/services/notifications/userNotificationService';

const FEED_URL = '/api/accounting/notifications';
const READ_URL = '/api/accounting/notifications/read';
const LOAD_FAILED = 'Could not load notifications - try again';

async function postRead(body: { ids: string[] } | { all: true }): Promise<void> {
  const res = await apiFetch(READ_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await assertOk(res, 'Could not mark that read - try again');
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(FEED_URL);
      await assertOk(res, LOAD_FAILED);
      const json = (await res.json()) as { data?: NotificationFeed };
      if (!json.data || !Array.isArray(json.data.items)) throw new Error('notification feed: not the feed envelope');
      setFeed(json.data);
      setLoadError('');
    } catch (err) {
      log.warn('notification feed load failed', { err });
      // Never a stale list or badge under the error.
      setFeed(null);
      setLoadError(apiErrorMessage(err, LOAD_FAILED));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setActionError('');
    if (next) void load();
  };

  const follow = (n: UserNotification) => {
    if (n.href === null || !isInAppPath(n.href)) return;
    setOpen(false);
    void router.push(n.href);
  };

  const openItem = async (n: UserNotification) => {
    setActionError('');
    if (n.readAt === null) {
      try {
        await postRead({ ids: [n.id] });
      } catch (err) {
        setActionError(apiErrorMessage(err, 'Could not mark that read - try again'));
        return;
      }
      const readAt = new Date().toISOString();
      setFeed((f) => f && {
        items: f.items.map((x) => (x.id === n.id ? { ...x, readAt } : x)),
        unread: Math.max(0, f.unread - 1),
      });
    }
    follow(n);
  };

  const markAll = async () => {
    setActionError('');
    try {
      await postRead({ all: true });
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Could not mark them read - try again'));
      return;
    }
    const readAt = new Date().toISOString();
    setFeed((f) => f && { items: f.items.map((x) => (x.readAt === null ? { ...x, readAt } : x)), unread: 0 });
  };

  const unread = feed?.unread ?? 0;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="Notifications"
        aria-haspopup="true"
        aria-expanded={open}
        aria-describedby={unread > 0 ? 'notification-unread' : undefined}
        title="Notifications"
        className={cn(
          'relative p-2 rounded-lg transition-colors text-ink-muted hover:text-ink hover:bg-surface-sunken',
          open && 'bg-surface-sunken text-ink',
        )}
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 dark:bg-red-500 text-white text-xs font-bold flex items-center justify-center leading-none"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {unread > 0 && <span id="notification-unread" className="sr-only">{`${unread} unread notifications`}</span>}

      {open && (
        <div
          role="group"
          aria-label="Notifications"
          className="fixed right-2 left-2 top-14 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80 z-50 rounded-xl border border-line bg-surface-raised shadow-xl"
        >
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-line">
            <span className="text-sm font-medium text-ink">Notifications</span>
            {unread > 0 && (
              <button type="button" onClick={() => void markAll()} className="text-xs text-teal-700 dark:text-teal-400 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {actionError && <p role="alert" className="px-3 py-2 text-xs text-red-700 dark:text-red-400">{actionError}</p>}
          {loadError && <p role="alert" className="px-3 py-4 text-sm text-red-700 dark:text-red-400">{loadError}</p>}
          {feed && feed.items.length === 0 && <p className="px-3 py-4 text-sm text-ink-muted">No notifications yet</p>}
          {feed && feed.items.length > 0 && (
            <ul className="max-h-96 overflow-y-auto py-1">
              {feed.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => void openItem(n)}
                    className="w-full text-left px-3 py-2 hover:bg-surface-sunken flex gap-2"
                  >
                    <span
                      aria-hidden="true"
                      className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', n.readAt === null ? 'bg-red-600 dark:bg-red-500' : 'bg-transparent')}
                    />
                    <span className="min-w-0">
                      <span className={cn('block text-sm text-ink truncate', n.readAt === null && 'font-semibold')}>{n.title}</span>
                      {n.body && <span className="block text-xs text-ink-muted line-clamp-2">{n.body}</span>}
                      <span className="block text-xs text-ink-muted">{formatDisplayDateTime(n.createdAt, '')}</span>
                      {n.readAt === null && <span className="sr-only">Unread</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
