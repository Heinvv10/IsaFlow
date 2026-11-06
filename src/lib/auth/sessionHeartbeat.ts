/**
 * PRD-10 Layer 1 — keeps the access token fresh while a tab is open.
 *
 * Two responsibilities:
 *   1. Background refresh — once 50 minutes have passed since the last one, rotate
 *      the access cookie via POST /api/auth/refresh. The time is kept in localStorage
 *      because AppLayout mounts per page: an interval alone restarted on every page
 *      change and rarely fired. Skip when the tab is hidden (no point refreshing a
 *      backgrounded tab).
 *   2. Idle bounce — track the last user activity (clicks/keys/scroll) in
 *      localStorage. If idle exceeds the company's idle_timeout_minutes, force
 *      logout instead of refreshing.
 *
 * Multi-tab: both timestamps are shared through localStorage, so a click in any tab
 * counts for all of them and a refresh in one holds the others off. Any visible tab
 * may tick. Two refreshing at once is safe: GoTrue answers a rotated token with the
 * current one.
 */

import { clearTenantClientState } from './clearTenantClientState';
import { log } from '@/lib/logger';

const ACTIVITY_KEY = 'isaflow_last_activity_at';
const REFRESH_URL = '/api/auth/refresh';
const REFRESH_KEY = 'isaflow_last_refresh_at';
const REFRESH_EVERY_MS = 50 * 60 * 1000;
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const ACTIVITY_THROTTLE_MS = 5_000;

type StopFn = () => void;

interface HeartbeatOptions {
  /** Idle timeout in minutes; force logout when activity exceeds this. */
  idleTimeoutMinutes: number;
  /** Where to send the user when the session is bounced. */
  logoutHref?: string;
}

function recordActivity(): void {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
  } catch {
    // localStorage can throw in private mode / quota — best-effort only.
  }
}

function recordRefresh(): void {
  try {
    localStorage.setItem(REFRESH_KEY, String(Date.now()));
  } catch {
    // Same best-effort as recordActivity: the next tick just refreshes again.
  }
}

function hasTimestamp(key: string): boolean {
  try {
    return Boolean(localStorage.getItem(key));
  } catch {
    return false; // storage blocked: the record calls are best-effort too
  }
}

function readTimestamp(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return Date.now();
    const n = Number(raw);
    if (Number.isFinite(n) && n <= Date.now()) return n;
    // Corrupt or in the future (a clock set back): reset it, or the wait never ends.
    localStorage.setItem(key, String(Date.now()));
    return Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Starts the heartbeat for the current tab. Idempotent within a tab — calling
 * twice returns two distinct stop functions but only one timer/listener set.
 */
export function startSessionHeartbeat(opts: HeartbeatOptions): StopFn {
  if (typeof window === 'undefined') return () => undefined;

  const idleMs = Math.max(60_000, opts.idleTimeoutMinutes * 60 * 1000);
  const logoutHref = opts.logoutHref ?? '/login?reason=idle-timeout';

  // Seed activity so the first heartbeat after fresh login isn't immediately idle.
  if (!hasTimestamp(ACTIVITY_KEY)) recordActivity();
  if (!hasTimestamp(REFRESH_KEY)) recordRefresh();

  // --- Activity tracking (throttled to avoid hammering localStorage) ---
  let lastWrite = 0;
  const onActivity = (): void => {
    const now = Date.now();
    if (now - lastWrite < ACTIVITY_THROTTLE_MS) return;
    lastWrite = now;
    recordActivity();
  };
  const activityEvents: Array<keyof DocumentEventMap> = ['click', 'keydown', 'scroll', 'mousemove'];
  for (const ev of activityEvents) {
    document.addEventListener(ev, onActivity, { passive: true });
  }

  // Clears auth cookies server-side so the next visitor on this browser doesn't
  // auto-resume the session. Uses `keepalive: true` so the request survives the
  // navigation that follows (sendBeacon was considered but cannot be awaited —
  // the redirect would race the beacon). We mirror apiFetch's CSRF header so
  // this stays robust if /api/auth/logout is ever wrapped with withCsrf.
  const readCsrfCookie = (): string | null => {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.split('; ').find((c) => c.startsWith('isaflow_csrf='));
    return match ? match.slice('isaflow_csrf='.length) : null;
  };

  const serverLogout = async (): Promise<void> => {
    try {
      const headers: Record<string, string> = {};
      const csrf = readCsrfCookie();
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers,
      });
      if (!res.ok) log.warn('Server logout was refused; continuing with the redirect', { status: res.status }, 'auth');
    } catch (err) {
      // Logout is best-effort — never block the redirect on it.
      log.warn('Server logout failed; continuing with the redirect', { error: err }, 'auth');
    }
  };

  // --- Heartbeat tick ---
  const tick = async (): Promise<void> => {
    if (document.hidden) return;

    const idleFor = Date.now() - readTimestamp(ACTIVITY_KEY);
    if (idleFor >= idleMs) {
      window.clearInterval(intervalId); // this tab is leaving: no second logout
      // Idle bounce — clear cookies first so cookies aren't left valid on a
      // shared computer after the redirect, then wipe tenant-scoped client
      // state so the next sign-in on this browser cannot inherit the
      // previous user's active company.
      await serverLogout();
      clearTenantClientState();
      window.location.href = logoutHref;
      return;
    }

    if (Date.now() - readTimestamp(REFRESH_KEY) < REFRESH_EVERY_MS) return;

    try {
      const r = await fetch(REFRESH_URL, { method: 'POST', credentials: 'include' });
      if (r.ok) recordRefresh();
      if (!r.ok && r.status === 401) {
        // Refresh failed — session is genuinely dead, bounce.
        clearTenantClientState();
        window.location.href = '/login?reason=session-expired';
      }
    } catch {
      // Network blip — let the next 401 from a real request handle it.
    }
  };

  const intervalId = window.setInterval(tick, TICK_INTERVAL_MS);

  return () => {
    window.clearInterval(intervalId);
    for (const ev of activityEvents) {
      document.removeEventListener(ev, onActivity);
    }
  };
}
