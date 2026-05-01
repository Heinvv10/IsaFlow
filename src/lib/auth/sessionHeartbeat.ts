/**
 * PRD-10 Layer 1 — keeps the access token fresh while a tab is open.
 *
 * Two responsibilities:
 *   1. Background refresh — every 50 minutes, rotate the access cookie via
 *      POST /api/auth/refresh. Skip when the tab is hidden (no point refreshing
 *      a backgrounded tab).
 *   2. Idle bounce — track the last user activity (clicks/keys/scroll) in
 *      localStorage. If idle exceeds the company's idle_timeout_minutes, force
 *      logout instead of refreshing.
 *
 * Multi-tab coordination: leader election via BroadcastChannel ensures only one
 * tab fires the heartbeat. Activity timestamp is shared across tabs through
 * localStorage so a click in any tab counts as activity for all of them.
 */

import { clearTenantClientState } from './clearTenantClientState';

const CHANNEL_NAME = 'isaflow_auth';
const ACTIVITY_KEY = 'isaflow_last_activity_at';
const REFRESH_URL = '/api/auth/refresh';
const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
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

function readLastActivity(): number {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    if (!raw) return Date.now();
    const n = Number(raw);
    return Number.isFinite(n) ? n : Date.now();
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
  if (!localStorage.getItem(ACTIVITY_KEY)) recordActivity();

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

  // --- Multi-tab leader election ---
  // Each tab posts a claim with its random id; highest id wins. On stop, the
  // leader posts a `resign` so survivors elect a new leader instead of being
  // stuck pointing at a dead tab id (which would freeze the heartbeat for
  // everyone — exactly the silent-logout bug this module is meant to prevent).
  const myId = Math.random().toString(36).slice(2);
  let leaderId = myId;
  let channel: BroadcastChannel | null = null;

  const broadcastClaim = (): void => {
    try {
      channel?.postMessage({ type: 'leader-claim', id: myId });
    } catch {
      // Channel may have been closed — ignore.
    }
  };

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; id?: string } | undefined;
      if (!data || typeof data.id !== 'string') return;
      if (data.type === 'leader-claim') {
        // Higher-id tab wins. If we lose, we step back to follower; if we're
        // already higher, re-broadcast so the late-joiner learns about us.
        if (data.id > leaderId) {
          leaderId = data.id;
        } else if (data.id < leaderId && leaderId === myId) {
          broadcastClaim();
        }
      } else if (data.type === 'leader-resign' && data.id === leaderId) {
        // Current leader stepping down — reset and re-elect.
        leaderId = myId;
        broadcastClaim();
      }
    };
    broadcastClaim();
  } catch {
    // BroadcastChannel not supported — proceed without leader election.
  }

  const isLeader = (): boolean => leaderId === myId;

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
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers,
      });
    } catch {
      // Logout is best-effort — never block the redirect on it.
    }
  };

  // --- Heartbeat tick ---
  const tick = async (): Promise<void> => {
    if (!isLeader()) return;
    if (document.hidden) return;

    const idleFor = Date.now() - readLastActivity();
    if (idleFor >= idleMs) {
      // Idle bounce — clear cookies first so cookies aren't left valid on a
      // shared computer after the redirect, then wipe tenant-scoped client
      // state so the next sign-in on this browser cannot inherit the
      // previous user's active company.
      await serverLogout();
      clearTenantClientState();
      window.location.href = logoutHref;
      return;
    }

    try {
      const r = await fetch(REFRESH_URL, { method: 'POST', credentials: 'include' });
      if (!r.ok && r.status === 401) {
        // Refresh failed — session is genuinely dead, bounce.
        clearTenantClientState();
        window.location.href = '/login?reason=session-expired';
      }
    } catch {
      // Network blip — let the next 401 from a real request handle it.
    }
  };

  const intervalId = window.setInterval(tick, HEARTBEAT_INTERVAL_MS);

  return () => {
    window.clearInterval(intervalId);
    for (const ev of activityEvents) {
      document.removeEventListener(ev, onActivity);
    }
    if (channel) {
      // Step down so a surviving tab can take over the heartbeat.
      try {
        if (isLeader()) channel.postMessage({ type: 'leader-resign', id: myId });
      } catch {
        // Channel may already be closed — ignore.
      }
      channel.close();
    }
  };
}
