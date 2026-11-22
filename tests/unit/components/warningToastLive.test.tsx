/**
 * PR #1703 review r14 M1: the cancel's reopen warning is announced (role="status", aria-live polite). react-hot-toast gives a custom
 * toast no live region, so `notify.warning` takes an opt-in `live`; every other warning caller renders exactly as before.
 */
import { render, screen, cleanup, act } from '@testing-library/react';
import toast, { Toaster } from 'react-hot-toast';
import { afterEach, describe, expect, it } from 'vitest';
import { notify } from '@/utils/toast';

afterEach(() => { act(() => { toast.remove(); }); cleanup(); });

describe('notify.warning live', () => {
  it('with live: a polite status region carrying the title', async () => {
    render(<Toaster />);
    act(() => { notify.warning('Purchase order PO-9 reopened to approved', 'Commits again: PO-9', { live: true }); });
    const region = await screen.findByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Purchase order PO-9 reopened to approved');
  });
  it('without it: no status region (other callers unchanged)', async () => {
    render(<Toaster />);
    act(() => { notify.warning('Unsaved changes'); });
    await screen.findByText('Unsaved changes');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
