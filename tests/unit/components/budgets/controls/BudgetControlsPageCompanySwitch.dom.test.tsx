/**
 * Switching company on the budget controls page (PR #1115 review): the user holds the SAME role in
 * both companies, so the hook's role flags do not change. The page must still drop the first
 * company's controls and alerts at once, reload for the second, ignore a late answer for the first,
 * and never save a stale policy to the new company.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlsView } from '@/components/accounting/budgets/controls/controlsClient';

const h = vi.hoisted(() => ({
  company: { id: 'co-a', name: 'A' } as { id: string; name: string } | null,
  fetchControls: vi.fn(),
  fetchAlerts: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', activeCompany: h.company }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/accounting/budgets/controls/controlsClient', async (orig) => ({
  ...(await orig<typeof import('@/components/accounting/budgets/controls/controlsClient')>()),
  fetchControls: h.fetchControls, fetchAlerts: h.fetchAlerts, saveSettings: h.saveSettings,
  evaluateNow: vi.fn(), saveOverride: vi.fn(), deleteOverride: vi.fn(),
}));

import { BudgetControlsPage } from '@/components/accounting/budgets/controls/BudgetControlsPage';

const view = (policy: 'off' | 'warn' | 'block'): ControlsView => ({
  settings: { checkPolicy: policy, alertEmailEnabled: false, defaultThresholds: [80, 100], updatedAt: '2026-11-03T08:00:00.000Z' },
  overrides: [], options: { accounts: [], cc1: [], cc2: [], units: [] }, emailAllowedOnServer: false, lastEvaluated: { daily: null, manual: null },
});
const alerts = (label: string) => ({ open: [], resolved: [], lastEvaluated: { daily: label, manual: null } });
const ok = <T,>(data: T) => ({ ok: true as const, data });
const policySelect = () => screen.getByLabelText('Budget check on bill approval') as HTMLSelectElement;

beforeEach(() => {
  h.company = { id: 'co-a', name: 'A' };
  for (const m of [h.fetchControls, h.fetchAlerts, h.saveSettings]) m.mockReset();
  h.fetchAlerts.mockResolvedValue(ok(alerts('a')));
});
afterEach(cleanup);

describe('BudgetControlsPage company switch', () => {
  it('clears company A at once, reloads for B, and a save then goes with B\'s data, not A\'s edits', async () => {
    h.fetchControls.mockResolvedValueOnce(ok(view('block')));
    const { rerender } = render(<BudgetControlsPage />);
    await waitFor(() => expect(policySelect().value).toBe('block'));
    fireEvent.change(policySelect(), { target: { value: 'off' } }); // unsaved edit in A

    let resolveB!: (v: ReturnType<typeof ok>) => void;
    h.fetchControls.mockReturnValueOnce(new Promise((r) => { resolveB = r; }));
    h.company = { id: 'co-b', name: 'B' };
    rerender(<BudgetControlsPage />);

    expect(screen.queryByLabelText('Budget check on bill approval')).toBeNull(); // A is gone while B loads
    expect(screen.getByLabelText('Loading the budget controls')).toBeInTheDocument();
    expect(h.fetchControls).toHaveBeenCalledTimes(2);

    await act(async () => { resolveB(ok(view('warn'))); });
    await waitFor(() => expect(policySelect().value).toBe('warn')); // B's saved policy, not A's unsaved 'off'
    expect(screen.getByTestId('budget-settings-save')).toBeDisabled(); // nothing dirty to save
  });

  it('a late answer for company A after the switch never shows', async () => {
    let resolveA!: (v: ReturnType<typeof ok>) => void;
    h.fetchControls.mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    const { rerender } = render(<BudgetControlsPage />);
    h.fetchControls.mockResolvedValueOnce(ok(view('warn')));
    h.company = { id: 'co-b', name: 'B' };
    rerender(<BudgetControlsPage />);
    await waitFor(() => expect(policySelect().value).toBe('warn'));
    await act(async () => { resolveA(ok(view('block'))); });
    expect(policySelect().value).toBe('warn');
  });
});
