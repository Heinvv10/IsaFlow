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
  fireEvent.change(screen.getByRole('combobox', {name: 'Company'}), {target: {value: 'velo'}});
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
  expect(await screen.findByText(/could not load that company/i)).toBeInTheDocument();
});

it('says so when no company matches the search', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => response({items: [], total: 0}));
  render(<SubscriptionCompanyPicker companyId="" onChange={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox', {name: 'Company'}), {target: {value: 'zzz'}});
  await waitFor(() => expect(screen.getByText(/no companies match/i)).toBeInTheDocument());
});

it('a company that cannot be loaded is dropped, and searching afterwards still works', async () => {
  const onChange = vi.fn();
  const BAD = '22222222-2222-4222-8222-222222222222';
  const view = render(<SubscriptionCompanyPicker companyId={BAD} onChange={onChange} />);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
  view.rerender(<SubscriptionCompanyPicker companyId="" onChange={onChange} />);
  expect(screen.getByText(/could not load that company/i)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', {name: 'Company'}), {target: {value: 'velo'}});
  fireEvent.click(await screen.findByRole('option', {name: VELOCITY.name}));
  expect(onChange).toHaveBeenLastCalledWith(VELOCITY.id);
});

it('picks a company with the keyboard', async () => {
  const onChange = vi.fn();
  render(<SubscriptionCompanyPicker companyId="" onChange={onChange} />);
  const box = screen.getByRole('combobox', {name: 'Company'});
  fireEvent.change(box, {target: {value: 'velo'}});
  await screen.findByRole('option', {name: VELOCITY.name});
  fireEvent.keyDown(box, {key: 'ArrowDown'});
  expect(screen.getByRole('option', {name: VELOCITY.name})).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, {key: 'Enter'});
  expect(onChange).toHaveBeenCalledWith(VELOCITY.id);
});

it('a failed search clears the previous results instead of leaving them pickable', async () => {
  render(<SubscriptionCompanyPicker companyId="" onChange={vi.fn()} />);
  const box = screen.getByRole('combobox', {name: 'Company'});
  fireEvent.change(box, {target: {value: 'velo'}});
  await screen.findByRole('option', {name: VELOCITY.name});
  vi.mocked(apiFetch).mockImplementation(async () => response(null, 500));
  fireEvent.change(box, {target: {value: 'velox'}});
  expect(await screen.findByText(/could not search companies/i)).toBeInTheDocument();
  expect(screen.queryByRole('option')).toBeNull();
});

it('marks a company that is not active', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => response({items: [{...VELOCITY, status: 'suspended'}], total: 1}));
  render(<SubscriptionCompanyPicker companyId="" onChange={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox', {name: 'Company'}), {target: {value: 'velo'}});
  expect(await screen.findByRole('option', {name: /Velocity Fibre.*suspended/})).toBeInTheDocument();
});

it('switching the preselected company does not keep showing the previous name', async () => {
  const OTHER = { id: '33333333-3333-4333-8333-333333333333', name: 'Blitz Fibre (Pty) Ltd' };
  let releaseOther: () => void = () => undefined;
  vi.mocked(apiFetch).mockImplementation(async url => {
    if (String(url) === `/api/admin/companies/${OTHER.id}`) {
      await new Promise<void>(r => { releaseOther = r; });
      return response(OTHER);
    }
    return response(VELOCITY);
  });
  const view = render(<SubscriptionCompanyPicker companyId={VELOCITY.id} onChange={vi.fn()} />);
  await screen.findByText(VELOCITY.name);
  view.rerender(<SubscriptionCompanyPicker companyId={OTHER.id} onChange={vi.fn()} />);
  expect(screen.queryByText(VELOCITY.name)).toBeNull();
  releaseOther();
  expect(await screen.findByText(OTHER.name)).toBeInTheDocument();
});

it('Enter after the results shrink does not pick a row that is gone', async () => {
  const onChange = vi.fn();
  const B = { id: '44444444-4444-4444-8444-444444444444', name: 'Velocity Two' };
  vi.mocked(apiFetch).mockImplementation(async url =>
    response({items: new URL(String(url), 'http://x').searchParams.get('search') === 'velo' ? [VELOCITY, B] : [VELOCITY]}));
  render(<SubscriptionCompanyPicker companyId="" onChange={onChange} />);
  const box = screen.getByRole('combobox', {name: 'Company'});
  fireEvent.change(box, {target: {value: 'velo'}});
  await screen.findByRole('option', {name: B.name});
  fireEvent.change(box, {target: {value: 'veloc'}});
  // the old two rows are still on screen while the new search is in flight
  fireEvent.keyDown(box, {key: 'ArrowDown'});
  fireEvent.keyDown(box, {key: 'ArrowDown'});
  await waitFor(() => expect(screen.queryByRole('option', {name: B.name})).toBeNull());
  fireEvent.keyDown(box, {key: 'Enter'});
  expect(onChange).not.toHaveBeenCalled();
});

it('a row highlighted on the old results is not what Enter picks from the new ones', async () => {
  const onChange = vi.fn();
  const X = { id: '55555555-5555-4555-8555-555555555555', name: 'Xylo Co' };
  vi.mocked(apiFetch).mockImplementation(async url =>
    response({items: new URL(String(url), 'http://x').searchParams.get('search') === 'velo' ? [VELOCITY] : [X]}));
  render(<SubscriptionCompanyPicker companyId="" onChange={onChange} />);
  const box = screen.getByRole('combobox', {name: 'Company'});
  fireEvent.change(box, {target: {value: 'velo'}});
  await screen.findByRole('option', {name: VELOCITY.name});
  fireEvent.change(box, {target: {value: 'x'}});
  fireEvent.keyDown(box, {key: 'ArrowDown'}); // highlights Velocity, still on screen
  await screen.findByRole('option', {name: X.name});
  fireEvent.keyDown(box, {key: 'Enter'});
  expect(onChange).not.toHaveBeenCalled();
});
