// Admin SARS Codes (WP13, admin audit 4.17): a filter change loads the list for the value just picked. The select
// handlers called load() in the same tick as setState, so the request carried the previous filter.
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
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok({ releases: [], codes: [], taxYear: 2026 }));
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
