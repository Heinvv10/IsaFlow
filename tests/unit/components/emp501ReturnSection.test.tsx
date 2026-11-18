/**
 * Wave 6 EFb: the EMP501 return section on the EMP501 page. The Interim/Annual picker sets the period the lifecycle bar
 * loads from the payroll-detail EMP501 route (interim 1 Mar to 31 Aug, annual to the end of February of the page's tax
 * year), and a finalise posts to that route with the action in the body.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Emp501ReturnSection } from '@/components/payroll/emp501/Emp501ReturnSection';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', activeCompany: { id: 'c1' } }) }));

const gets: string[] = [];
const posts: Array<{ url: string; body: unknown }> = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  gets.length = 0; posts.length = 0;
  document.cookie = 'is_impersonating=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json(200, { success: true, data: {} });
    }
    if (url.startsWith('/api/payroll/emp501/returns?')) {
      gets.push(url);
      return json(200, { success: true, data: { versions: [], vatReturn: null, readiness: null } });
    }
    if (url.startsWith('/api/accounting/company-users')) return json(200, { success: true, data: [] });
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ready = () => waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).not.toBe('Loading…'));

it('starts on the interim reconciliation and loads March to August of the tax year from the EMP501 route', async () => {
  render(<Emp501ReturnSection taxYear={2026} />);
  expect(screen.getByRole('heading', { name: 'EMP501 return' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: /Reconciliation/ }).textContent).toMatch(/Interim \(March to August\)/);
  await ready();
  expect(gets.at(-1)).toBe('/api/payroll/emp501/returns?periodStart=2025-03-01&periodEnd=2025-08-31');
});

it('the annual reconciliation loads March to the end of February', async () => {
  render(<Emp501ReturnSection taxYear={2026} />);
  await ready();
  fireEvent.click(screen.getByRole('combobox', { name: /Reconciliation/ }));
  fireEvent.click(await screen.findByRole('option', { name: /Annual \(March to February\)/ }));
  await waitFor(() => expect(gets.at(-1)).toBe('/api/payroll/emp501/returns?periodStart=2025-03-01&periodEnd=2026-02-28'));
});

it('finalise posts the action and the interim period to the EMP501 route', async () => {
  render(<Emp501ReturnSection taxYear={2026} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: /^Finalise v1$/ }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toMatch(/Finalise EMP501 v1/);
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({ url: '/api/payroll/emp501/returns', body: { action: 'finalise', periodStart: '2025-03-01', periodEnd: '2025-08-31' } });
});
