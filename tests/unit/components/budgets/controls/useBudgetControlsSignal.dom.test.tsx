/**
 * Evaluate now tells the header bell to refetch (P5-4 browser proof follow-up): after a successful
 * evaluation the controls page dispatches `isaflow:notifications-changed` on window; a failed one
 * dispatches nothing.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationsSignal';

const c = vi.hoisted(() => ({
  evaluateNow: vi.fn(),
  fetchControls: vi.fn(async () => ({ ok: true, data: { settings: {}, overrides: [], options: {}, emailAllowedOnServer: false, lastEvaluated: { daily: null, manual: null } } })),
  fetchAlerts: vi.fn(async () => ({ ok: true, data: { open: [], resolved: [], lastEvaluated: { daily: null, manual: null } } })),
}));
vi.mock('@/components/accounting/budgets/controls/controlsClient', () => ({
  evaluateNow: c.evaluateNow, fetchControls: c.fetchControls, fetchAlerts: c.fetchAlerts,
  saveSettings: vi.fn(), saveOverride: vi.fn(), deleteOverride: vi.fn(),
}));

import { useBudgetControls } from '@/components/accounting/budgets/controls/useBudgetControls';

const heard = vi.fn();
beforeEach(() => { heard.mockClear(); window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, heard); });
afterEach(() => { window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, heard); cleanup(); });

describe('Evaluate now signals the bell', () => {
  it('a successful evaluation dispatches the event once', async () => {
    c.evaluateNow.mockResolvedValueOnce({ ok: true, data: { fiscalYear: 2027, keys: 9, fired: 2, resolved: 0, lastEvaluated: { daily: null, manual: null } } });
    const { result } = renderHook(() => useBudgetControls(true, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.evaluate(); });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a failed evaluation dispatches nothing', async () => {
    c.evaluateNow.mockResolvedValueOnce({ ok: false, kind: 'busy', message: 'busy', retryAfter: null });
    const { result } = renderHook(() => useBudgetControls(true, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.evaluate(); });
    expect(heard).not.toHaveBeenCalled();
  });
});
