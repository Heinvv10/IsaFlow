/**
 * D2 round 12: two checks for a create/delete page that navigates after its write succeeded.
 *  - a navigation still in flight keeps the busy control disabled; one that resolves false (cancelled) releases it,
 *  - a router.push that REJECTS after the write succeeded never reads as "the write failed", and the control is released.
 */
import { expect, vi, type Mock } from 'vitest';
import { waitFor } from '@testing-library/react';

export interface NavCase {
  push: Mock;
  /** The mocked `log.warn`: a rejected navigation is logged, not shown. */
  warn: Mock;
  /** Renders the page, fills what the write needs and submits. Must make the write succeed. */
  drive: () => Promise<void> | void;
  /** The control the person clicked. Omit it only when the page removes that control once the write succeeded. */
  button?: () => HTMLElement | null;
  /** True when the page tells the person the WRITE failed (text, alert or toast). */
  claimsFailure: () => boolean;
}

const disabled = (c: NavCase) => (c.button!() as HTMLButtonElement | null)?.disabled === true;

export async function pendingNavigationKeepsButtonDisabled(c: NavCase) {
  let release!: (v: boolean) => void;
  const nav = new Promise<boolean>((r) => { release = r; });
  c.push.mockReset(); c.push.mockImplementation(() => nav);
  await c.drive();
  await waitFor(() => expect(c.push).toHaveBeenCalled());
  if (c.button) expect(disabled(c)).toBe(true);
  expect(c.claimsFailure()).toBe(false);
  release(false); // the route change was cancelled
  if (c.button) await waitFor(() => expect(disabled(c)).toBe(false));
  await Promise.resolve();
  expect(c.claimsFailure()).toBe(false);
}

export async function rejectedNavigationIsNotAWriteFailure(c: NavCase) {
  c.push.mockReset(); c.push.mockRejectedValue(new Error('Route did not complete'));
  c.warn.mockClear();
  await c.drive();
  await waitFor(() => expect(c.push).toHaveBeenCalled());
  await waitFor(() => expect(c.warn).toHaveBeenCalledWith('navigation failed', expect.anything(), expect.any(String)));
  if (c.button) await waitFor(() => expect(disabled(c)).toBe(false));
  expect(c.claimsFailure()).toBe(false);
}
