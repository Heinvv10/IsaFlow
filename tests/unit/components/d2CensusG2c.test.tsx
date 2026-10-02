// D2 census group 2c: the delivery-address, chart-of-accounts and UDF loads show the server's message (400) or a plain
// sentence (empty 500), never an empty list / raw "Unexpected end of JSON input". REAL assertOk / apiErrorMessage over a scripted apiFetch.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, boom, expectNoRawJsonError, ok, script } from '../helpers/d2CensusG2';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/components/accounting/AccountCategorySidebar', async (orig) => ({ ...(await orig<object>()), AccountCategorySidebar: () => null }));
vi.mock('@/components/accounting/dashboard/AccountRow', () => ({ AccountRow: ({ account }: { account: { accountName: string } }) => <tr><td>{account.accountName}</td></tr> }));
vi.mock('@/components/accounting/dashboard/CoaSeedEmptyState', () => ({ CoaSeedEmptyState: () => <p>seed state</p> }));
vi.mock('@/components/accounting/dashboard/AddAccountForm', () => ({ AddAccountForm: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: ({ children }: { children?: ReactNode }) => <>{children}</> }));

import { notify } from '@/utils/toast';
import { ChartOfAccountsTab } from '../../../src/components/accounting/dashboard/ChartOfAccountsTab';
import { DeliveryAddressesTab } from '../../../src/components/accounting/customers/DeliveryAddressesTab';
import { UdfTab } from '../../../src/components/accounting/settings/UdfTab';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(notify.error).mockClear(); });

describe('delivery addresses tab', () => {
  const url = 'customer-delivery-addresses';
  it('400: shows the server message', async () => {
    script(url, bad);
    render(<DeliveryAddressesTab customerId="c1" />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    script(url, boom);
    render(<DeliveryAddressesTab customerId="c1" />);
    expect(await screen.findByText(/Could not load delivery addresses/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: lists the addresses', async () => {
    script(url, () => ok([{ id: 'd1', address_name: 'D2 Warehouse Annex', address_line1: null, address_line2: null, city: null, province: null, postal_code: null, country: null, is_default: false }]));
    render(<DeliveryAddressesTab customerId="c1" />);
    expect(await screen.findByText('D2 Warehouse Annex')).toBeTruthy();
    expect(screen.queryByText(MSG)).toBeNull();
  });
});

describe('chart of accounts tab', () => {
  const url = '/api/accounting/chart-of-accounts?';
  it('400: notifies the server message', async () => {
    script(url, bad);
    render(<ChartOfAccountsTab />);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
  });
  it('500 with an empty body: notifies a plain sentence, not the JSON parse error', async () => {
    script(url, boom);
    render(<ChartOfAccountsTab />);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not load the chart of accounts - try again'));
    expect(vi.mocked(notify.error).mock.calls.flat().join(' ')).not.toMatch(/JSON|Unexpected end/);
  });
  it('200: lists the accounts', async () => {
    script(url, () => ok([{ id: 'a1', accountCode: '1000', accountName: 'D2 Petty Cash', accountType: 'asset', isActive: true }]));
    render(<ChartOfAccountsTab />);
    expect(await screen.findByText('D2 Petty Cash')).toBeTruthy();
    expect(notify.error).not.toHaveBeenCalled();
  });
});

describe('UDF tab', () => {
  const url = '/api/accounting/udf-definitions';
  const open = async () => { render(<UdfTab />); fireEvent.click((await screen.findAllByRole('button'))[0]!); };
  it('400: shows the server message', async () => {
    script(url, bad);
    await open();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('500 with an empty body: shows a plain sentence, not the JSON parse error', async () => {
    script(url, boom);
    await open();
    expect(await screen.findByText(/Could not load field definitions/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('200: shows the configured field label', async () => {
    script(url, () => ok([{ id: 'u1', entityType: 'customer', fieldNumber: 1, fieldLabel: 'D2 Custom Label', fieldType: 'text', fieldOptions: null, isRequired: false, isActive: true }]));
    await open();
    expect(await screen.findByDisplayValue('D2 Custom Label')).toBeTruthy();
    expect(screen.queryByText(MSG)).toBeNull();
  });
});
