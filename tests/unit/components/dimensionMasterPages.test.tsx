/**
 * #678 review M3 / M5 / M6: the cost-centre and business-unit master pages,
 * rendered. Delete asks first (nothing is sent until confirmed); an edit keeps
 * the current parent even when it is inactive (listed, marked, sent by id);
 * the CC2 tab shows parent, FNO and aliases; aliases go as a list; the BU form
 * sends the division; and a refusal the API returns is painted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => <button>Export CSV</button> }));

import CostCentresPage from '@/../pages/accounting/cost-centres/index';
import BusinessUnitsPage from '@/../pages/accounting/business-units/index';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const refuse = (message: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message } }), { status: 400 });
const posts = () => apiFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST')
  .map((c) => JSON.parse(String((c[1] as { body: string }).body)) as Record<string, unknown>);

const CENTRES = [
  { id: 'f1', code: 'FT001', name: 'Fibretime', ccType: 'cc1', isActive: false, parentId: null, fnoCode: 'FT001', aliases: [] },
  { id: 'f2', code: 'HT001', name: 'Hightel', ccType: 'cc1', isActive: true, parentId: null, fnoCode: 'HT001', aliases: [] },
  { id: 'p1', code: 'FT-LAW', name: 'Lawley', ccType: 'cc2', isActive: false, parentId: 'f1', parentCode: 'FT001', fnoCode: 'FT001', aliases: ['Lawley Ext', 'LAW'] },
];

function serveCentres(onPost: (body: Record<string, unknown>) => Response = () => ok({})) {
  apiFetch.mockImplementation(async (_url: string, init?: { method?: string; body?: string }) =>
    (init?.method === 'POST' ? onPost(JSON.parse(String(init.body))) : ok({ items: CENTRES })));
}
const cc2Tab = async () => {
  render(<CostCentresPage />);
  await screen.findByText('Hightel');
  fireEvent.click(screen.getByText('CC2 — Project'));
  await screen.findByText('Lawley');
};

describe('cost centres page', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('shows parent, FNO and aliases on the CC2 tab', async () => {
    serveCentres();
    await cc2Tab();
    const row = screen.getByText('Lawley').closest('tr')!;
    expect(within(row).getAllByText('FT001')).toHaveLength(2); // parent and FNO
    expect(within(row).getByText('Lawley Ext, LAW')).toBeTruthy();
  });

  it('edit lists the inactive current parent, marked, selected, and sends it by id with the aliases as a list (M3)', async () => {
    serveCentres();
    await cc2Tab();
    fireEvent.click(within(screen.getByText('Lawley').closest('tr')!).getByTitle('Edit'));
    const select = screen.getByLabelText('Parent') as HTMLSelectElement;
    expect(select.value).toBe('f1');
    expect(within(select).getByText(/FT001 — Fibretime \(inactive\)/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Aliases/), { target: { value: 'Lawley Ext, , New One' } });
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ action: 'update', id: 'p1', parent: 'f1', aliases: ['Lawley Ext', 'New One'] });
  });

  it('a new CC2 lists only active parents (an inactive one is not offered)', async () => {
    serveCentres();
    await cc2Tab();
    fireEvent.click(screen.getByText(/New CC2/));
    const select = screen.getByLabelText('Parent') as HTMLSelectElement;
    expect(within(select).queryByText(/Fibretime/)).toBeNull();
    expect(within(select).getByText(/HT001 — Hightel/)).toBeTruthy();
  });

  it('paints the refusal a save returns', async () => {
    serveCentres(() => refuse('Moving FT-LAW from FNO FT001 to HT001 would leave the CC1 wrong on 3 line(s)'));
    await cc2Tab();
    fireEvent.click(within(screen.getByText('Lawley').closest('tr')!).getByTitle('Edit'));
    fireEvent.change(screen.getByLabelText('Parent'), { target: { value: 'f2' } });
    fireEvent.click(screen.getByText('Update'));
    expect(await screen.findByText(/would leave the CC1 wrong on 3 line/)).toBeTruthy();
  });

  it('delete asks first: cancel sends nothing, confirm sends the delete (M5)', async () => {
    serveCentres();
    render(<CostCentresPage />);
    await screen.findByText('Hightel');
    fireEvent.click(within(screen.getByText('Hightel').closest('tr')!).getByTitle('Delete'));
    expect(within(screen.getByRole('dialog')).getByText(/Delete HT001 — Hightel\?/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(screen.getByText('Hightel').closest('tr')!).getByTitle('Delete'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts()).toEqual([{ action: 'delete', id: 'f2' }]));
  });
});

const UNITS = [{ id: 'b1', code: 'OPS', name: 'Operations', division: 'Build & Delivery', isActive: true }];
function serveUnits(onPost: (body: Record<string, unknown>) => Response = () => ok({})) {
  apiFetch.mockImplementation(async (_url: string, init?: { method?: string; body?: string }) =>
    (init?.method === 'POST' ? onPost(JSON.parse(String(init.body))) : ok({ items: UNITS })));
}

describe('business units page', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('shows the division and sends it on edit; a blank division is sent as \'\' (clears)', async () => {
    serveUnits();
    render(<BusinessUnitsPage />);
    expect(await screen.findByText('Build & Delivery')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.change(screen.getByPlaceholderText(/Division/), { target: { value: '' } });
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ action: 'update', id: 'b1', division: '', code: 'OPS' });
  });

  it('delete asks first, and paints the counted refusal (M5)', async () => {
    serveUnits(() => refuse('Cannot delete business unit that is used by 4 journal line(s). Deactivate instead.'));
    render(<BusinessUnitsPage />);
    await screen.findByText('Operations');
    fireEvent.click(screen.getByTitle('Delete'));
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Cannot delete business unit that is used by 4 journal line(s). Deactivate instead.')).toBeTruthy();
    expect(posts()).toEqual([{ action: 'delete', id: 'b1' }]);
    expect(screen.getByText('Operations')).toBeTruthy();
  });
});
