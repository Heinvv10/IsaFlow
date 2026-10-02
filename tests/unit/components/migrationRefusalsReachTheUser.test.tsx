/**
 * W2-28 round 11: the migration screens show the server's refusal. The row-cap
 * 400 ("This request has 7,501 accounts and one request takes at most 7,500.
 * Split the chart…") tells the user what to do, and all three callers read
 * `json.message` — the envelope is `{ error: { message } }` — so they showed
 * "Import failed" / "Migration failed". Each test answers with the real envelope.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/migration/AccountMappingTable', () => ({ AccountMappingTable: () => null }));
vi.mock('@/components/accounting/migration/CoaImportResult', () => ({ CoaImportResult: () => null }));
vi.mock('papaparse', () => ({
  default: { parse: (_file: unknown, opts: { complete: (r: unknown) => void }) => opts.complete({
    data: [{ account_code: '1000', account_name: 'Bank', account_type: 'asset' }], meta: { fields: ['account_code', 'account_name', 'account_type'] } }) },
}));

import { apiFetch } from '@/lib/apiFetch';
import { ExternalMigrationWizard } from '@/components/accounting/migration/ExternalMigrationWizard';
import AdminMigrationsPage from '../../../pages/admin/tools/migrations';
import CoaMigrationPage from '../../../pages/accounting/migration/chart-of-accounts';

void mockedApiFetchModule;
useApiJsonOverMock();

const CAP = 'This request has 7,501 accounts and one request takes at most 7,500. Split the chart into files of up to 7,500 accounts';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const PARSED = [{ sourceCode: '1000', sourceName: 'Bank', sourceType: 'BANK', mappedType: 'asset' }];
const file = () => new File(['code,name\n1000,Bank'], 'accounts.csv', { type: 'text/csv' });
const upload = (input: Element) => fireEvent.change(input, { target: { files: [file()] } });

function answer() {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('migration-execute') || u.endsWith('/migration/chart-of-accounts')) {
      return json({ success: false, error: { code: 'BAD_REQUEST', message: CAP } }, 400);
    }
    if (u.includes('migration-parse')) return json({ success: true, data: { parsed: PARSED, count: 1 } });
    if (u.includes('/api/admin/companies')) return json({ success: true, data: { items: [{ id: 'co-1', name: 'Acme', trading_name: null }] } });
    if (u.includes('/migration/session')) return json({ success: true, data: { session: { id: 'session-1', sourceSystem: 'sage' } } });
    return json({ success: true, data: {} });
  });
}

afterEach(() => { cleanup(); });

it('the Xero/QuickBooks/Pastel wizard shows why the import was refused', async () => {
  answer();
  const { container } = render(<ExternalMigrationWizard source="xero" onDone={() => undefined} onBack={() => undefined} />);
  upload(container.querySelectorAll('input[type="file"]')[0]!);
  await screen.findByText(/1 records parsed/);
  fireEvent.click(screen.getByRole('button', { name: /next: map accounts/i }));
  fireEvent.click(screen.getByRole('button', { name: /next: review/i }));
  fireEvent.click(screen.getByRole('button', { name: /import now/i }));
  expect(await screen.findByText(new RegExp(CAP.slice(0, 60)))).toBeTruthy();
});

it('the admin migration tool shows why the migration was refused', async () => {
  answer();
  const { container } = render(<AdminMigrationsPage />);
  await screen.findByRole('option', { name: 'Acme' });
  upload(container.querySelectorAll('input[type="file"]')[0]!);
  fireEvent.click(await screen.findByRole('button', { name: /execute migration/i }));
  expect(await screen.findByText(new RegExp(CAP.slice(0, 60)))).toBeTruthy();
});

it('the chart-of-accounts import page shows why the import was refused', async () => {
  answer();
  const { container } = render(<CoaMigrationPage />);
  upload(container.querySelector('input[type="file"]')!);
  const go = await screen.findByRole('button', { name: /import 1 accounts/i });
  await vi.waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(go);
  expect(await screen.findByText(new RegExp(CAP.slice(0, 60)))).toBeTruthy();
});
