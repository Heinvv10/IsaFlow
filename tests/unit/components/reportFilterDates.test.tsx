// Report filter dates are DateFields: typed text commits on blur / Enter, and refused text never
// reaches the filter state, so it never fetches. Sales by Item stands for the 28 report pages.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { dateFieldInputs, typeDate } from '../helpers/dateFields';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import SalesByItem from '../../../pages/accounting/reports/sales-by-item';

const reportUrls = () => vi.mocked(apiFetch).mock.calls.map((c) => String(c[0])).filter((u) => u.includes('sales-by-item'));

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));
});
afterEach(() => cleanup());

describe('report filter dates', () => {
  it('"1 Oct 2026" + blur requests from=2026-10-01', async () => {
    const { container } = render(<SalesByItem />);
    await waitFor(() => expect(reportUrls().length).toBe(1));
    typeDate(dateFieldInputs(container)[0]!, '1 Oct 2026');
    await waitFor(() => expect(reportUrls().at(-1)).toContain('from=2026-10-01'));
  });

  it('Enter commits the typed date', async () => {
    const { container } = render(<SalesByItem />);
    await waitFor(() => expect(reportUrls().length).toBe(1));
    const to = dateFieldInputs(container)[1]!;
    fireEvent.change(to, { target: { value: 'eom' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    await waitFor(() => expect(reportUrls().length).toBe(2));
    expect(reportUrls().at(-1)).toMatch(/to=\d{4}-\d{2}-\d{2}$/);
  });

  it('refused text ("zz") never changes the filter, so it never fetches', async () => {
    const { container } = render(<SalesByItem />);
    await waitFor(() => expect(reportUrls().length).toBe(1));
    typeDate(dateFieldInputs(container)[0]!, 'zz');
    await new Promise((r) => setTimeout(r, 50));
    expect(reportUrls()).toHaveLength(1);
    expect(reportUrls().some((u) => u.includes('from=&') || u.includes('from=zz'))).toBe(false);
  });
});
