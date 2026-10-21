/**
 * Shared-pool UI: the bank line's "Common at other ISAFlow clients" hint shows only while the selection is
 * still the pool's suggestion; the Merchant Categories page lists every category, saves a pick, and runs
 * auto-map.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedPoolHint, SHARED_POOL_HINT } from '@/components/accounting/bank-transactions/SharedPoolHint';
import { SHARED_POOL_LABEL } from '@/modules/accounting/services/sharedPool/sharedSuggestionService';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));

import MerchantCategoriesPage from '../../../pages/accounting/merchant-categories/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); apiFetch.mockReset(); });

describe('SharedPoolHint', () => {
  it('shows the label while the selection is the pool suggestion', () => {
    render(<SharedPoolHint suggestedStrategy="shared_pool" suggestedGlAccountId="gl-1" selectedEntityId="gl-1" />);
    expect(screen.getByTestId('shared-pool-hint').textContent).toBe('Common at other ISAFlow clients');
  });

  it('is the same wording the service labels the suggestion with', () => {
    expect(SHARED_POOL_HINT).toBe(SHARED_POOL_LABEL);
  });

  it.each([
    ['another strategy', { suggestedStrategy: 'pattern', suggestedGlAccountId: 'gl-1', selectedEntityId: 'gl-1' }],
    ['the person picked another account', { suggestedStrategy: 'shared_pool', suggestedGlAccountId: 'gl-1', selectedEntityId: 'gl-2' }],
    ['nothing selected', { suggestedStrategy: 'shared_pool', suggestedGlAccountId: 'gl-1', selectedEntityId: null }],
  ])('hidden when %s', (_l, props) => {
    render(<SharedPoolHint {...props} />);
    expect(screen.queryByTestId('shared-pool-hint')).toBeNull();
  });
});

describe('Merchant Categories page', () => {
  const categories = [
    { code: 'fuel', label: 'Fuel', poolable: true, mapping: { glAccountId: 'a1', accountCode: '6100', accountName: 'Fuel', source: 'auto' } },
    { code: 'salaries', label: 'Salaries & wages', poolable: false, mapping: null },
  ];
  const accounts = [
    { id: 'a1', accountCode: '6100', accountName: 'Fuel' }, { id: 'a2', accountCode: '6200', accountName: 'Telephone' },
    { id: 'h1', accountCode: '6000', accountName: 'Operating Expenses' },
    { id: 'a3', accountCode: '6010', accountName: 'Old Sub', parentAccountId: 'h1', isActive: false },
    { id: 'a4', accountCode: '6300', accountName: 'Closed', isActive: false },
  ];

  function serve() {
    apiFetch.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.startsWith('/api/accounting/chart-of-accounts')) return ok(accounts);
      if (init?.body) return ok(JSON.parse(init.body).action === 'auto_map' ? { mapped: 3, ambiguous: ['telephone'] } : { saved: true });
      return ok({ listVersion: 1, categories });
    });
  }

  it('lists each category with its mapping state', async () => {
    serve();
    render(<MerchantCategoriesPage />);
    expect(await screen.findByText('Auto-mapped by account name')).toBeTruthy();
    expect(screen.getByText('Never shared with other clients')).toBeTruthy();
    expect((screen.getByLabelText('Fuel') as HTMLSelectElement).value).toBe('a1');
  });

  it('offers active posting accounts only: no header (even one whose children are all inactive), no inactive account', async () => {
    serve();
    render(<MerchantCategoriesPage />);
    const options = [...(await screen.findByLabelText('Fuel') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['', 'a1', 'a2']);
  });

  it('says that mapped coding counts toward other clients\' suggestions when the bureau shares', async () => {
    serve();
    render(<MerchantCategoriesPage />);
    expect(await screen.findByText(/your coding on mapped accounts also counts \(anonymously\) toward these suggestions for other ISAFlow clients/)).toBeTruthy();
  });

  it('flags an account two categories map to as not shared', async () => {
    const both = [
      { code: 'telephone', label: 'Telephone', poolable: true, mapping: { glAccountId: 'a2', accountCode: '6200', accountName: 'Telephone', source: 'auto' } },
      { code: 'internet', label: 'Internet', poolable: true, mapping: { glAccountId: 'a2', accountCode: '6200', accountName: 'Telephone', source: 'manual' } },
      ...categories,
    ];
    apiFetch.mockImplementation(async (url: string) => (url.startsWith('/api/accounting/chart-of-accounts') ? ok(accounts) : ok({ listVersion: 1, categories: both })));
    render(<MerchantCategoriesPage />);
    expect(await screen.findAllByText('Not shared: this account is mapped to more than one category')).toHaveLength(2);
    expect(screen.getByText('Auto-mapped by account name')).toBeTruthy(); // fuel, on its own account
  });

  it('saves a pick for one category', async () => {
    serve();
    render(<MerchantCategoriesPage />);
    fireEvent.change(await screen.findByLabelText('Fuel'), { target: { value: 'a2' } });
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[1]?.body)).toBe(true));
    const body = JSON.parse(apiFetch.mock.calls.find((c) => c[1]?.body)![1].body);
    expect(body).toEqual({ action: 'save', categoryCode: 'fuel', glAccountId: 'a2' });
  });

  it('auto-map reports what it did and what it left for a person', async () => {
    serve();
    render(<MerchantCategoriesPage />);
    fireEvent.click(await screen.findByText('Auto-map by account name'));
    expect(await screen.findByText(/Auto-mapped 3 categories; 1 matched more than one account/)).toBeTruthy();
  });

  it('a failed load shows the error and a retry, not an empty list', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: 'nope' } }), { status: 500 }));
    render(<MerchantCategoriesPage />);
    expect(await screen.findByText('Try again')).toBeTruthy();
  });
});
