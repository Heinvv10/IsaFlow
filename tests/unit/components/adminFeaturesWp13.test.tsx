// Admin Feature Flags (WP13, admin audit 3.7): global availability changes access for every tenant, so the bulk
// Enable/Disable and a row's Global toggle wait for a confirm, and a bulk run shows which flags failed.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import FeaturesPage from '../../../pages/admin/features';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const flag = (id: string, code: string) => ({ id, code, name: code, description: null, is_global: false, created_at: '2026-01-01T00:00:00Z' });
const FLAGS = [flag('f-1', 'budgets'), flag('f-2', 'payroll')];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    if (init?.method === 'PATCH') {
      return String(url).endsWith('/f-2')
        ? new Response(JSON.stringify({ success: false, error: { message: 'nope' } }), { status: 400 })
        : ok({ ...FLAGS[0], is_global: true });
    }
    return ok(FLAGS);
  });
});
afterEach(() => { cleanup(); });
const patches = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'PATCH');

describe('feature flags', () => {
  it('bulk Enable waits for a confirm, then names the flag that failed', async () => {
    render(<FeaturesPage />);
    fireEvent.click(await screen.findByLabelText('Select all feature flags'));
    fireEvent.click(screen.getByRole('button', { name: /enable selected/i }));
    const dialog = await screen.findByRole('dialog');
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /enable globally/i }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(await screen.findByText(/1 updated, 1 failed \(payroll\)/)).toBeTruthy();
  });

  it("a row's Global toggle waits for a confirm", async () => {
    render(<FeaturesPage />);
    await screen.findByText('budgets', { selector: 'code' });
    fireEvent.click(screen.getAllByTitle('Edit feature flag')[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /plan only/i }));
    fireEvent.click(screen.getByTitle('Save'));
    const dialog = await screen.findByRole('dialog');
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /enable globally/i }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]![1]?.body))).toMatchObject({ is_global: true });
  });
});
