/**
 * A same-tab signal that the caller's in-app notifications may have changed (budgets P5-4: Evaluate
 * now writes bell notifications; the header bell would otherwise show the old badge until a reload
 * or until it is opened). Client only: a window CustomEvent, no payload; the listener refetches.
 */
export const NOTIFICATIONS_CHANGED_EVENT = 'isaflow:notifications-changed';

export function signalNotificationsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
}

/** Calls `handler` on each signal; returns the unsubscribe. */
export function onNotificationsChanged(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, handler);
}
