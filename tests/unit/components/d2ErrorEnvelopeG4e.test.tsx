/**
 * D2: the admin migration tool shows the server's parse refusal, and renders the REAL
 * /api/accounting/migration-execute result ({ accountsImported, customersImported, suppliersImported,
 * openingBalancesSet, errors }) instead of the old per-type { succeeded, failed } shape.
 * NOT TESTED: the companies-list load site (the message is only logged, never rendered).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import AdminMigrationsPage from '../../../pages/admin/tools/migrations';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const PARSED = [{ sourceCode: '1000', sourceName: 'Bank', sourceType: 'BANK', mappedType: 'asset' }];
const file = () => new File(['code,name\n1000,Bank'], 'accounts.csv', { type: 'text/csv' });

function script(parse: Response, execute?: Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('migration-execute')) return execute ?? json({ success: true, data: {} });
    if (u.includes('migration-parse')) return parse.clone();
    if (u.includes('/api/admin/companies')) return json({ success: true, data: { items: [{ id: 'co-1', name: 'Acme', trading_name: null }] } });
    return json({ success: true, data: {} });
  });
}
const parsedOk = () => json({ success: true, data: { parsed: PARSED, count: 1 } });

async function uploadAndExecute() {
  const { container } = render(<AdminMigrationsPage />);
  await screen.findByRole('option', { name: 'Acme' });
  fireEvent.change(container.querySelectorAll('input[type="file"]')[0]!, { target: { files: [file()] } });
  fireEvent.click(await screen.findByRole('button', { name: /execute migration/i }));
  return container;
}

afterEach(() => { cleanup(); });

describe('admin migration tool', () => {
  it('parse refused: the zone shows the server message', async () => {
    const msg = 'D2 server says no: accounts.csv has no header row';
    script(json({ success: false, error: { code: 'BAD_REQUEST', message: msg } }, 400));
    const { container } = render(<AdminMigrationsPage />);
    await screen.findByRole('option', { name: 'Acme' });
    fireEvent.change(container.querySelectorAll('input[type="file"]')[0]!, { target: { files: [file()] } });
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('execute refused: the page shows the server message', async () => {
    const msg = 'D2 server says no: company Acme already has posted journals';
    script(parsedOk(), json({ success: false, error: { code: 'CONFLICT', message: msg } }, 409));
    await uploadAndExecute();
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('a clean 200 execute renders the real counts and "Migration complete"', async () => {
    script(parsedOk(), json({ success: true, data: {
      accountsImported: 2, customersImported: 3, suppliersImported: 4, customersSkipped: 5, suppliersSkipped: 0,
      openingBalancesSet: 1, errors: [] } }));
    await uploadAndExecute();
    expect(await screen.findByText('Migration complete')).toBeTruthy();
    expect(screen.getByText('2 imported')).toBeTruthy();
    expect(screen.getByText('3 imported')).toBeTruthy();
    expect(screen.getByText('4 imported')).toBeTruthy();
    expect(screen.getByText('1 opening balances set')).toBeTruthy();
    expect(screen.getByText('5 skipped')).toBeTruthy();   // customers: sent but not inserted
    expect(screen.queryByText('0 skipped')).toBeNull();
    expect(screen.queryByText('Migration finished with problems')).toBeNull();
  });

  it('a batch that failed says failed, not skipped', async () => {
    script(parsedOk(), json({ success: true, data: {
      accountsImported: 0, customersImported: 0, suppliersImported: 4, customersSkipped: 1, customersFailed: 2, suppliersSkipped: 0,
      suppliersFailed: 0, openingBalancesSet: 0, errors: ['Customers batch: value too long'] } }));
    await uploadAndExecute();
    expect(await screen.findByText('2 failed, nothing was saved')).toBeTruthy();
    expect(screen.getByText('1 skipped')).toBeTruthy();
    expect(screen.queryByText('3 skipped')).toBeNull();
  });

  it('a 200 execute with batch errors renders "finished with problems" and the error text', async () => {
    script(parsedOk(), json({ success: true, data: {
      accountsImported: 2, customersImported: 3, suppliersImported: 0, openingBalancesSet: 0, errors: ['Suppliers batch: boom'] } }));
    await uploadAndExecute();
    expect(await screen.findByText('Migration finished with problems')).toBeTruthy();
    expect(screen.getByText('Suppliers batch: boom')).toBeTruthy();
    expect(screen.getByText('0 imported')).toBeTruthy();
    expect(screen.queryByText('Migration complete')).toBeNull();
  });
});
