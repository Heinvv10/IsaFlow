import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubscriptionCompanyPicker } from '@/components/admin/SubscriptionCompanyPicker';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());

const VELOCITY = { id: '11111111-1111-4111-8111-111111111111', name: 'Velocity Fibre (Pty) Ltd' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify({data}), {status});

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async url => {
    const u = String(url);
    if (u === `/api/admin/companies/${VELOCITY.id}`) return response({...VELOCITY, status: 'active'});
    if (u.startsWith('/api/admin/companies?')) return response({items: [VELOCITY], total: 1});
    return response(null, 404);
  });
});
afterEach(cleanup);

it('shows the name, not the id, for a preselected company', async () => {
  render(<SubscriptionCompanyPicker companyId={VELOCITY.id} onChange={vi.fn()} />);
  expect(await screen.findByText(VELOCITY.name)).toBeInTheDocument();
  expect(screen.queryByDisplayValue(VELOCITY.id)).toBeNull();
  expect(screen.queryByText(VELOCITY.id)).toBeNull();
});

it('searches by name and hands back the picked company id', async () => {
  const onChange = vi.fn();
  render(<SubscriptionCompanyPicker companyId="" onChange={onChange} />);
  fireEvent.change(screen.getByPlaceholderText(/search company/i), {target: {value: 'velo'}});
  fireEvent.click(await screen.findByRole('option', {name: VELOCITY.name}));
  expect(onChange).toHaveBeenCalledWith(VELOCITY.id);
  const search = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).find(u => u.startsWith('/api/admin/companies?'));
  expect(new URL(search!, 'http://x').searchParams.get('search')).toBe('velo');
});

it('Change clears the selection so another company can be picked', async () => {
  const onChange = vi.fn();
  render(<SubscriptionCompanyPicker companyId={VELOCITY.id} onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', {name: /change/i}));
  expect(onChange).toHaveBeenCalledWith('');
});

it('says so when a preselected company cannot be loaded', async () => {
  render(<SubscriptionCompanyPicker companyId="22222222-2222-4222-8222-222222222222" onChange={vi.fn()} />);
  expect(await screen.findByText(/could not load the company/i)).toBeInTheDocument();
});

it('says so when no company matches the search', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => response({items: [], total: 0}));
  render(<SubscriptionCompanyPicker companyId="" onChange={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText(/search company/i), {target: {value: 'zzz'}});
  await waitFor(() => expect(screen.getByText(/no companies match/i)).toBeInTheDocument());
});
