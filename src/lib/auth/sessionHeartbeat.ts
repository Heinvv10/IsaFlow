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
  // Each tab posts a claim with its random id and a timestamp; the highest id
  // wins. This is best-effort (ties resolve quickly) and degrades gracefully if
  // BroadcastChannel is unavailable (each tab heartbeats; refresh endpoint is
  // idempotent enough that this is safe — just slightly wasteful).
  const myId = Math.random().toString(36).slice(2);
  let leaderId = myId;
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; id?: string } | undefined;
      if (data?.type === 'leader-claim' && typeof data.id === 'string') {
        if (data.id > leaderId) leaderId = data.id;
      }
    };
    channel.postMessage({ type: 'leader-claim', id: myId });
  } catch {
    // BroadcastChannel not supported — proceed without leader election.
  }

  const isLeader = (): boolean => leaderId === myId;

  // --- Heartbeat tick ---
  const tick = async (): Promise<void> => {
    if (!isLeader()) return;
    if (document.hidden) return;

    const idleFor = Date.now() - readLastActivity();
    if (idleFor >= idleMs) {
      // Idle bounce — don't refresh, just send the user to the login screen.
      window.location.href = logoutHref;
      return;
    }

    try {
      const r = await fetch(REFRESH_URL, { method: 'POST', credentials: 'include' });
      if (!r.ok && r.status === 401) {
        // Refresh failed — session is genuinely dead, bounce.
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
    channel?.close();
  };
}
