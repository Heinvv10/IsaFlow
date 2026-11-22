/**
 * The invoice line grid on the line-level VAT form: a VAT type column for a VAT vendor (none for a company not
 * registered), and the dimensions (job, CC2 project, BU) on their own row under each line with their names shown, not
 * three more squeezed table columns (they clipped at 1280 px).
 */
import { cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fillLine, serve } from '../helpers/invoiceDefaultsHarness';

const reg = vi.hoisted(() => ({ isRegistered: true }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/hooks/useVatRegistration', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useVatRegistration')>()),
  useVatRegistrationOrDefault: () => ({ isRegistered: reg.isRegistered, known: true }),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); reg.isRegistered = true; });

const open = async () => { serve(); render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); };
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);

describe('the VAT column', () => {
  it('a VAT vendor: a VAT column, a type per line, the line total its net', async () => {
    await open();
    expect(headers()).toContain('VAT');
    fillLine(0, '115');
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getByRole('combobox', { name: 'VAT type' }).textContent).toMatch(/^Standard \(\d+%\)$/);
    expect(row.textContent).toMatch(/R\s?115\.00/);
  });
  it('a company not registered for VAT: no VAT column at all', async () => {
    reg.isRegistered = false;
    await open();
    expect(headers()).not.toContain('VAT');
    expect(screen.queryAllByRole('combobox', { name: 'VAT type' })).toEqual([]);
  });
});

describe('the dimensions', () => {
  it('sit on a row of their own under the line, named, not as table columns', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Dimensions' }));
    expect(headers().some((h) => /BU|CC2|Job/.test(h ?? ''))).toBe(false);
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // the header, the line, its dimensions
    const dims = rows[2]!;
    for (const name of ['Job (Project Profitability)', 'CC2 project', 'BU']) {
      expect(within(dims).getByRole('combobox', { name })).toBeTruthy();
      const label = within(dims).getByText(name, { selector: 'label' });
      expect(label.className).not.toMatch(/sr-only/); // shown, so a narrow picker is never the only clue
    }
    expect(dims.querySelector('td')!.getAttribute('colspan')).toBe(String(within(rows[1]!).getAllByRole('cell').length));
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    expect(screen.getAllByRole('combobox', { name: 'BU' })).toHaveLength(2);
  });
});
