// AP supplier statements list: cards below lg with labelled cells and 44px controls; the table is unchanged from lg up.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import Page from '../../../pages/accounting/ap/supplier-statements/index';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = {
  id: 'r1', supplierId: 's1', supplierName: 'Acme Supplies', statementDate: '2026-11-01', periodStart: '2026-10-01', periodEnd: '2026-10-31',
  supplierBalance: 100, isaflowBalance: 90, variance: 10, status: 'unreconciled', missingInIsaflowCount: 0, missingInStatementCount: 0, amountDiffCount: 0, createdAt: '2026-11-01',
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/suppliers-list')) return json({ suppliers: [], total: 0 });
    if (u.startsWith('/api/accounting/supplier-statements')) return json([row]);
    throw new Error(`unexpected apiFetch ${u}`);
  });
});
afterEach(cleanup);

describe('AP supplier statements on touch', () => {
  it('renders the list as labelled cards with 44px controls', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Supplies');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    // Not a fixed 800px wide on a phone; the width floor only applies from lg.
    expect(table.className).not.toMatch(/(^|\s)min-w-\[800px\]/);
    expect(table.className).toContain('lg:min-w-[800px]');
    // Labels come from the headers, so a renamed header cannot drift from its data-label.
    const COLS = [...table.querySelectorAll('thead th')].map(th => th.textContent);
    expect(COLS).toHaveLength(7);
    const tds = [...table.querySelectorAll('tbody tr td')];
    expect(tds.map(td => td.getAttribute('data-label'))).toEqual(COLS);
    expect(screen.getByRole('button', { name: /Upload statement/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByPlaceholderText('All suppliers').className).toContain('max-lg:min-h-11');
    for (const name of ['All statuses', 'unreconciled', 'archived']) {
      expect(screen.getByRole('button', { name }).className).toContain('max-lg:min-h-11');
    }
  });

  it('gives the upload dialog 44px controls', async () => {
    render(<Page />);
    await screen.findByText('Acme Supplies');
    fireEvent.click(screen.getByRole('button', { name: /Upload statement/ }));
    for (const name of ['Cancel', 'Upload']) {
      expect(screen.getByRole('button', { name }).className).toContain('max-lg:min-h-11');
    }
    expect(document.querySelectorAll('input.max-lg\\:min-h-11').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Close' }).className).toMatch(/max-lg:min-h-11/);
  });
});
