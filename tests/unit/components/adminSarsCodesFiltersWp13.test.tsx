// Admin SARS Codes (WP13, admin audit 2026-11-14):
//  - 4.17 a filter change loads the list for the value just picked. The select handlers called load() in the
//    same tick as setState, so the request carried the previous filter;
//  - 4.13 the code drawer and the import wizard are modal dialogs that close on Escape.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SarsCodesPage from '../../../pages/admin/payroll/sars-codes';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok({ releases: [], taxYear: 2026, codes: [
    { code: '3601', foreign_code: '3651', description: 'Income - taxable', category: 'income', status: 'active',
      effective_year: 2026, brs_version: 'v25', irp5_section: null, is_taxable: true, notes: null },
  ] }));
});
afterEach(() => { cleanup(); });
const lastList = () => {
  const urls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/admin/payroll/sars-codes?'));
  return new URL(urls[urls.length - 1]!, 'http://x').searchParams;
};

describe('SARS code filters', () => {
  it('Category, Status and Reset each load with the value just chosen', async () => {
    render(<SarsCodesPage />);
    await waitFor(() => expect(lastList().get('taxYear')).toBe(null));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'fringe' } });
    await waitFor(() => expect(lastList().get('category')).toBe('fringe'));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'deprecated' } });
    await waitFor(() => expect(lastList().get('status')).toBe('deprecated'));
    expect(lastList().get('category')).toBe('fringe');
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    await waitFor(() => expect(lastList().get('category')).toBe(null));
    expect(lastList().get('status')).toBe(null);
  });
});

describe('SARS dialogs', () => {
  const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  it('the code drawer is modal and closes on Escape', async () => {
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByText('Income - taxable'));
    const drawer = await screen.findByRole('dialog', { name: /sars code 3601/i });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    escape();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the import wizard is modal and closes on Escape', async () => {
    render(<SarsCodesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /import xlsx/i }));
    const wizard = await screen.findByRole('dialog', { name: /import sars codes/i });
    await waitFor(() => expect(wizard.contains(document.activeElement)).toBe(true));
    escape();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
