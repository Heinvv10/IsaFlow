/**
 * Admin Announcements page, editing an existing announcement (audit 4.8 and W-3).
 *  - The Starts / Ends in the edit form are the SAST times the table shows, and saving without touching them sends the
 *    same instants back (it used to read the UTC clock into the box and re-save it as local: 2 h earlier per save).
 *  - A company-targeted announcement shows its companies as chips (it showed none, so they could not be reviewed or
 *    removed), and what is saved is what the chips say.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminAnnouncementsPage from '../../../pages/admin/tools/announcements';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
useApiJsonOverMock();

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// 08:00Z is 10:00 SAST.
const STARTS = '2026-11-14T08:00:00.000Z';
const ENDS = '2026-11-20T15:30:00.000Z';

type Row = Record<string, unknown>;
let rows: Row[];
let patches: Row[];
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });

const row = (over: Row = {}): Row => ({
  id: ID, title: 'Scheduled maintenance', message: 'm', type: 'maintenance', target: 'all', target_ids: [],
  starts_at: STARTS, ends_at: ENDS, is_dismissible: true, created_by: 'x', created_at: STARTS, ...over,
});

beforeEach(() => {
  patches = [];
  rows = [row()];
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.startsWith('/api/admin/announcements?')) return json({ items: rows });
    if (u === `/api/admin/announcements/${ID}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Row;
      patches.push(body);
      rows = [{ ...rows[0], ...body, ends_at: body.ends_at ?? null }]; // the server stores what it is sent
      return json({ id: ID });
    }
    if (u === `/api/admin/companies/${C1}`) return json({ id: C1, name: 'Alpha Fibre', status: 'active' });
    if (u === `/api/admin/companies/${C2}`) return json({ id: C2, name: 'Beta Fibre', status: 'trial' });
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  });
});
afterEach(cleanup);

const openEdit = async () => {
  render(<AdminAnnouncementsPage />);
  fireEvent.click(await screen.findByTitle('Edit'));
  return within(await screen.findByRole('dialog'));
};
const dateInputs = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'));
const save = async (dialog: ReturnType<typeof within>, n: number) => {
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(patches).toHaveLength(n));
};

describe('editing an announcement: dates', () => {
  it('the form shows the same SAST time as the table', async () => {
    render(<AdminAnnouncementsPage />);
    expect(await screen.findByText('14 Nov 2026, 10:00')).toBeInTheDocument(); // the table
    fireEvent.click(screen.getByTitle('Edit'));
    const [starts, ends] = dateInputs(await screen.findByRole('dialog'));
    expect(starts!.value).toBe('2026-11-14T10:00');
    expect(ends!.value).toBe('2026-11-20T17:30');
  });

  it('load, save unchanged: the same instants go back', async () => {
    const dialog = await openEdit();
    await save(dialog, 1);
    expect(Date.parse(String(patches[0]!.starts_at))).toBe(Date.parse(STARTS));
    expect(Date.parse(String(patches[0]!.ends_at))).toBe(Date.parse(ENDS));
  });

  it('three saves in a row do not drift', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const view = render(<AdminAnnouncementsPage />);
      fireEvent.click(await screen.findByTitle('Edit'));
      await save(within(await screen.findByRole('dialog')), i);
      view.unmount();
    }
    expect(patches.map(p => Date.parse(String(p.starts_at)))).toEqual([Date.parse(STARTS), Date.parse(STARTS), Date.parse(STARTS)]);
    expect(patches.map(p => Date.parse(String(p.ends_at)))).toEqual([Date.parse(ENDS), Date.parse(ENDS), Date.parse(ENDS)]);
  });

  it('a time typed in the box is SAST: 09:30 saves as 07:30Z; the untouched end keeps its instant', async () => {
    const dialog = await openEdit();
    fireEvent.change(dateInputs(screen.getByRole('dialog'))[0]!, { target: { value: '2026-11-15T09:30' } });
    await save(dialog, 1);
    expect(patches[0]!.starts_at).toBe('2026-11-15T07:30:00.000Z');
    expect(Date.parse(String(patches[0]!.ends_at))).toBe(Date.parse(ENDS));
  });
});

describe('editing an announcement: company targets', () => {
  beforeEach(() => { rows = [row({ target: 'company', target_ids: [C1, C2, GONE] })]; });

  it('shows each target company by name; one that cannot be loaded still shows, as unavailable', async () => {
    const dialog = await openEdit();
    expect(await dialog.findByText('Alpha Fibre')).toBeInTheDocument();
    expect(await dialog.findByText('Beta Fibre')).toBeInTheDocument();
    expect(await dialog.findByText(/Unavailable company \(33333333\)/)).toBeInTheDocument();
  });

  it('a chip can be removed, and the save carries exactly the remaining ids', async () => {
    const dialog = await openEdit();
    await dialog.findByText('Beta Fibre');
    fireEvent.click(dialog.getByRole('button', { name: 'Remove Alpha Fibre' }));
    fireEvent.click(await dialog.findByRole('button', { name: /Remove Unavailable company/ }));
    await save(dialog, 1);
    expect(patches[0]!.target).toBe('company');
    expect(patches[0]!.target_ids).toEqual([C2]);
  });

  it('saving without touching the chips keeps every target', async () => {
    const dialog = await openEdit();
    await dialog.findByText('Beta Fibre');
    await save(dialog, 1);
    expect(patches[0]!.target_ids).toEqual([C1, C2, GONE]);
  });
});
