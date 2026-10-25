/**
 * Only an owner or admin may buy Flows or change auto top-up (the API refuses everyone else with 403).
 * The Flows page and the wallet widget disable the Top up button and the auto top-up controls for any
 * other role, and say why; an owner sees them enabled. REAL page and widget over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const company = vi.hoisted(() => ({ companyRole: 'owner' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
import { cleanup, configure, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/billing/TopUpModal', () => ({ TopUpModal: () => null }));
vi.mock('@/components/billing/UpgradeNudgeBanner', () => ({ UpgradeNudgeBanner: () => null }));

import FlowsPage from '../../../pages/accounting/settings/billing/flows';
import { FlowWalletWidget } from '@/components/billing/FlowWalletWidget';

useApiJsonOverMock();
const COPY = 'Only the company owner or an admin can buy Flows or change auto top-up.';
const WALLET = { balance: 5, nudgeLevel: 'none', monthFlowsUsed: 0, autoTopupEnabled: true, autoTopupBundleId: 'b1' };
const serve = () => script((u) => (u.includes('/wallet') ? ok(WALLET) : u.includes('/ledger') ? ok({ entries: [] }) : ok([{ id: 'b1', name: 'Small', flows: 100, priceCents: 9900 }])));
const topUp = async () => (await screen.findByRole('button', { name: /top up/i })) as HTMLButtonElement;

beforeEach(() => { company.companyRole = 'owner'; serve(); });
afterEach(() => { cleanup(); });

describe('Flows page', () => {
  it.each(['viewer', 'manager', null])('role %s sees disabled Top up and auto top-up controls, and the reason', async (role) => {
    company.companyRole = role;
    render(<FlowsPage />);
    expect((await topUp()).disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(COPY)).toBeTruthy();
  });

  it.each(['owner', 'admin'])('%s sees enabled controls and no refusal copy', async (role) => {
    company.companyRole = role;
    render(<FlowsPage />);
    expect((await topUp()).disabled).toBe(false);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByText(COPY)).toBeNull();
  });
});

describe('Flows page: auto top-up has no payment method in v1', () => {
  it('says it is unavailable and lets nobody switch it on', async () => {
    script((u) => (u.includes('/wallet') ? ok({ ...WALLET, autoTopupEnabled: false, autoTopupBundleId: null })
      : u.includes('/ledger') ? ok({ entries: [] }) : ok([])));
    render(<FlowsPage />);
    expect((await topUp()).disabled).toBe(false);
    expect(screen.getByText(/no payment method on file/i)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('still lets an owner switch an existing setting off', async () => {
    render(<FlowsPage />);
    expect((await topUp()).disabled).toBe(false);
    expect(screen.getByText(/no payment method on file/i)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('Flow wallet widget', () => {
  it('a viewer sees a disabled Top up button and the reason', async () => {
    company.companyRole = 'viewer';
    render(<FlowWalletWidget />);
    expect((await topUp()).disabled).toBe(true);
    expect(screen.getByText(COPY)).toBeTruthy();
  });

  it('an owner sees an enabled Top up button', async () => {
    render(<FlowWalletWidget />);
    expect((await topUp()).disabled).toBe(false);
    expect(screen.queryByText(COPY)).toBeNull();
  });
});
