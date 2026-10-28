/**
 * DemoCompanyCTA persists "dismissed" in localStorage, which throws in some browsers (storage blocked,
 * quota). Dismissing, and a good switch, must still work; the failure is logged, not swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  switchCompany: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: h.logError, warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    activeCompany: { id: 'co-1', name: 'First Co' }, loading: false, switchCompany: h.switchCompany,
    companies: [{ companyId: 'co-1', companyName: 'First Co' }, { companyId: 'co-2', companyName: 'Demo Company', role: 'owner', isDemo: true }],
  }),
}));

import { DemoCompanyCTA } from '@/components/onboarding/DemoCompanyCTA';

const blocked = () => vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); h.switchCompany.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DemoCompanyCTA with storage that refuses writes', () => {
  it('dismiss still hides the banner, and logs the failure', async () => {
    blocked();
    render(<DemoCompanyCTA />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull());
    expect(h.logError).toHaveBeenCalledTimes(1);
  });

  it('a good switch does not throw out of the click handler, and logs the failure', async () => {
    blocked();
    render(<DemoCompanyCTA />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try the demo company' }));
    await waitFor(() => expect(h.logError).toHaveBeenCalledTimes(1));
  });
});
