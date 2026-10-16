import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SubscriptionsPage from '@/../pages/admin/billing/subscriptions';
import { NoSubscription } from '@/components/admin/companies/BillingTabParts';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
const route = vi.hoisted(() => ({
  query: {} as Record<string, string | string[]>, isReady: true, pathname: '/admin/billing/subscriptions',
  push: vi.fn(), replace: vi.fn(async () => true),
}));
vi.mock('next/router', () => ({ useRouter: () => route }));

const COMPANY = '21edeb24-224d-4813-92d7-248fee2b75e9';
const PLAN = '7d0c2f4e-1b3a-4c5d-8e9f-0a1b2c3d4e5f';
const response = (data: unknown) => new Response(JSON.stringify({data}), {status: 200});

beforeEach(() => {
  route.query = {};
  route.isReady = true;
  route.replace.mockClear();
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    if (String(url).includes('/plans')) return response([{id: PLAN, name: 'Starter', code: 'starter'}]);
    if (String(url) === `/api/admin/companies/${COMPANY}`) return response({id: COMPANY, name: 'Velocity Fibre (Pty) Ltd'});
    if (init?.method === 'POST') return response({id: 'sub-1'});
    return response({items: [], total: 0, page: 1, limit: 25});
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('Create Subscription on the company Billing tab goes to the existing subscriptions page', () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { set href(v: string) { assign(v); } });
  render(<NoSubscription companyId={COMPANY} />);
  screen.getByRole('button', {name: /create subscription/i}).click();
  expect(assign).toHaveBeenCalledWith(`/admin/billing/subscriptions?companyId=${COMPANY}`);
});

it('opens the Add Subscription form prefilled with ?companyId= by name, and drops the param', async () => {
  route.query = {companyId: COMPANY};
  render(<SubscriptionsPage />);
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(await screen.findByText('Velocity Fibre (Pty) Ltd')).toBeInTheDocument();
  expect(screen.queryByText(COMPANY)).toBeNull();
  expect(screen.queryByDisplayValue(COMPANY)).toBeNull();
  expect(route.replace).toHaveBeenCalledWith('/admin/billing/subscriptions', undefined, {shallow: true});
});

it('submits the prefilled form with the keys the strict API schema accepts', async () => {
  route.query = {companyId: COMPANY};
  render(<SubscriptionsPage />);
  const dialog = await screen.findByRole('dialog');
  await screen.findByRole('option', {name: /starter/i});
  fireEvent.change(dialog.querySelector('select')!, {target: {value: PLAN}});
  fireEvent.click(screen.getByRole('button', {name: /^create$/i}));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual(
    {company_id: COMPANY, plan_id: PLAN, billing_cycle: 'monthly', discount_percent: 0});
});

it.each([
  ['without ?companyId=', {}, true],
  ['before the router is ready', {companyId: COMPANY}, false],
  ['for an empty ?companyId=', {companyId: ''}, true],
  ['for a repeated ?companyId=', {companyId: [COMPANY, COMPANY]}, true],
])('keeps the form closed %s', async (_label, query, isReady) => {
  route.query = query;
  route.isReady = isReady;
  render(<SubscriptionsPage />);
  await screen.findByText('0 total');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(route.replace).not.toHaveBeenCalled();
});
