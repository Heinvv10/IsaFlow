/**
 * "Try the demo company": found by `isDemo` (never by name), shown only when the user
 * belongs to the demo tenant and is not already on it, and a refused switch keeps the offer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  switchCompany: vi.fn(),
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
  ctx: { companies: [] as Array<Record<string, unknown>>, activeCompany: { id: 'co-1' } as { id: string } | null },
}));
vi.mock('@/utils/toast', () => ({ notify: h.notify }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ ...h.ctx, switchCompany: h.switchCompany }),
}));

import { TryDemoLink } from '@/components/onboarding/TryDemoLink';
import { findDemoMembership } from '@/components/onboarding/demoMembership';

const own = { companyId: 'co-1', companyName: 'Demo Plumbing', role: 'owner', isDefault: true, isDemo: false };
const demo = { companyId: 'co-demo', companyName: 'Acme Sandbox', role: 'viewer', isDefault: false, isDemo: true };

beforeEach(() => {
  vi.clearAllMocks();
  h.ctx.companies = [own, demo];
  h.ctx.activeCompany = { id: 'co-1' };
  h.switchCompany.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('findDemoMembership', () => {
  it('finds the demo tenant by isDemo even when its name has no "demo" in it', () => {
    expect(findDemoMembership([own, demo], 'co-1')?.companyId).toBe('co-demo');
  });
  it('never matches a customer company that is merely called "Demo ..."', () => {
    expect(findDemoMembership([own], 'other')).toBeNull();
  });
  it('is null when the user is already on the demo company', () => {
    expect(findDemoMembership([own, demo], 'co-demo')).toBeNull();
  });
});

describe('<TryDemoLink>', () => {
  it('is hidden with no demo membership, even for a company named "Demo Plumbing"', () => {
    h.ctx.companies = [own];
    render(<TryDemoLink />);
    expect(screen.queryByText('Try the demo company')).toBeNull();
  });
  it('is hidden on the demo company itself', () => {
    h.ctx.activeCompany = { id: 'co-demo' };
    render(<TryDemoLink />);
    expect(screen.queryByText('Try the demo company')).toBeNull();
  });
  it('switches to the demo membership', async () => {
    const onSwitched = vi.fn();
    render(<TryDemoLink onSwitched={onSwitched} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try the demo company' }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(h.switchCompany).toHaveBeenCalledWith('co-demo');
  });
  it('a refused switch tells the user and does not report a switch', async () => {
    h.switchCompany.mockRejectedValue(new Error('no access'));
    const onSwitched = vi.fn();
    render(<TryDemoLink onSwitched={onSwitched} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try the demo company' }));
    await waitFor(() => expect(h.notify.error).toHaveBeenCalled());
    expect(onSwitched).not.toHaveBeenCalled();
  });
});
