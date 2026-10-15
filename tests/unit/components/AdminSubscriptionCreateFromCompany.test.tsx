import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SubscriptionsPage from '@/../pages/admin/billing/subscriptions';
import { NoSubscription } from '@/components/admin/companies/BillingTabParts';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string | string[]>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));

const COMPANY = '21edeb24-224d-4813-92d7-248fee2b75e9';
const response = (data: unknown) => new Response(JSON.stringify({data}), {status: 200});

beforeEach(() => {
  route.query = {};
  route.isReady = true;
  vi.mocked(apiFetch).mockReset().mockImplementation(async url =>
    String(url).includes('/plans') ? response([]) : response({items: [], total: 0, page: 1, limit: 25}));
});
afterEach(cleanup);

it('Create Subscription on the company Billing tab goes to the existing subscriptions page', () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { set href(v: string) { assign(v); } });
  render(<NoSubscription companyId={COMPANY} />);
  screen.getByRole('button', {name: /create subscription/i}).click();
  expect(assign).toHaveBeenCalledWith(`/admin/billing/subscriptions?companyId=${COMPANY}`);
  vi.unstubAllGlobals();
});

it('opens the Add Subscription form prefilled with ?companyId=', async () => {
  route.query = {companyId: COMPANY};
  render(<SubscriptionsPage />);
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(screen.getByDisplayValue(COMPANY)).toBeInTheDocument();
});

it('keeps the form closed without ?companyId=', async () => {
  render(<SubscriptionsPage />);
  await screen.findByText('0 total');
  expect(screen.queryByRole('dialog')).toBeNull();
});
