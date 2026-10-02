/**
 * D2 round 3 (a2): the report builder's export and CaseWare "Save All" fired their writes without
 * checking the response: a refused write still claimed success / showed nothing. Also CaseWare's
 * failed load must not keep the old mappings, and no raw err.message / 'Failed to load' may reach the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/reports/ReportBuilderFilters', () => ({ ReportBuilderFilters: () => null }));
vi.mock('@/components/accounting/reports/ReportBuilderPreview', () => ({ ReportBuilderPreview: () => null }));
vi.mock('@/components/accounting/reports/ReportBuilderSidebar', () => ({
  ReportBuilderSidebar: (p: { onSourceChange: (s: string) => void; onAddField: (f: unknown) => void }) => (
    <div>
      <button onClick={() => p.onSourceChange('invoices')}>pick-source</button>
      <button onClick={() => p.onAddField({ field: 'f1', label: 'F1', type: 'text', filterable: true })}>add-col</button>
    </div>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import Builder from '../../../pages/accounting/reports/builder';
import CaseWare from '../../../pages/accounting/reports/caseware-export';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const MSG = 'D2 server says no: refused';
const JUNK = /JSON|Unexpected end|HTTP \d|^Failed$|Failed to load|Save failed|Export failed/;
type Mode = 'ok' | '400' | '500';
let mode: Mode = 'ok';
let writes = 0;
beforeEach(() => { mode = 'ok'; writes = 0; });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => (mode === '400'
  ? new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 })
  : new Response('', { status: 500 }));

describe('report builder export', () => {
  const open = async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('custom-reports-export')) { writes++; return mode === 'ok' ? new Response('a,b', { status: 200 }) : refuse(); }
      return ok({ fields: [] });
    });
    const r = render(<Builder />);
    fireEvent.click(screen.getByText('pick-source'));
    fireEvent.click(screen.getByText('add-col'));
    return r;
  };
  const exportBtn = () => screen.getByText(/Export/, { selector: 'button, button *' });

  it('a refused export (400 envelope) shows the server message', async () => {
    mode = '400'; await open(); fireEvent.click(exportBtn());
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-body 500 export shows a plain sentence', async () => {
    mode = '500'; const { container } = await open(); fireEvent.click(exportBtn());
    expect(await screen.findByText('Could not export the report - try again')).toBeTruthy();
    expect(container.textContent).not.toMatch(JUNK);
  });
  it('a good export downloads a file and shows no error', async () => {
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const { container } = await open(); fireEvent.click(exportBtn());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/Could not export/);
  });
});

describe('CaseWare export page', () => {
  const MAP = { glAccountId: 'g1', accountCode: '1000', accountName: 'D2 Bank Acc', accountType: 'asset', accountSubtype: null, externalCode: 'OLD1', externalLabel: 'Old label' };
  let loadMode: Mode = 'ok';
  const script = () => vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const isWrite = (init as { method?: string } | undefined)?.method === 'POST';
    if (isWrite) { writes++; return mode === 'ok' ? ok({}) : refuse(); }
    if (loadMode === 'ok') return ok({ items: [MAP] });
    return loadMode === '400' ? new Response(JSON.stringify({ success: false, error: { code: 'X', message: MSG } }), { status: 400 }) : new Response('', { status: 500 });
  });
  beforeEach(() => { loadMode = 'ok'; });

  const edit = async () => {
    script();
    const r = render(<CaseWare />);
    const input = await screen.findByDisplayValue('OLD1');
    fireEvent.change(input, { target: { value: 'NEW1' } });
    return r;
  };

  it('a refused Save All (400 envelope) shows the server message and does not claim success', async () => {
    mode = '400'; await edit(); fireEvent.click(screen.getByText('Save All'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/Saved \d+ mapping/)).toBeNull();
  });
  it('an empty-body 500 Save All shows a plain sentence and no success', async () => {
    mode = '500'; const { container } = await edit(); fireEvent.click(screen.getByText('Save All'));
    expect(await screen.findByText(/Could not save the mappings - try again/)).toBeTruthy();
    expect(container.textContent).not.toMatch(JUNK);
    expect(screen.queryByText(/Saved \d+ mapping/)).toBeNull();
  });
  it('a good Save All says Saved 1 mapping(s)', async () => {
    await edit(); fireEvent.click(screen.getByText('Save All'));
    expect(await screen.findByText('Saved 1 mapping(s)')).toBeTruthy();
    expect(writes).toBe(1);
  });
  it('a 400 load shows the server message; an empty-body 500 load a plain sentence; neither keeps rows', async () => {
    loadMode = '400'; script(); const a = render(<CaseWare />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByDisplayValue('OLD1')).toBeNull();
    a.unmount();
    loadMode = '500'; const b = render(<CaseWare />);
    expect(await screen.findByText(/Could not load the account mappings - try again/)).toBeTruthy();
    expect(b.container.textContent).not.toMatch(JUNK);
  });
  it('a failed reload (auto-suggest succeeds, reload 500s) clears the old mappings', async () => {
    script(); const { container } = render(<CaseWare />);
    await screen.findByDisplayValue('OLD1');
    loadMode = '500';
    fireEvent.click(screen.getByText(/Auto-Suggest/));
    expect(await screen.findByText(/Could not load the account mappings - try again/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByDisplayValue('OLD1')).toBeNull());
    expect(container.textContent).toMatch(/Auto-suggested/);
  });
});
