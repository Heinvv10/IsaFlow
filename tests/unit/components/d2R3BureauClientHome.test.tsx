// D2 round 3: bureau/clients/[companyId] handleOpen. A refused company switch shows the message and does not navigate;
// a good switch navigates.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({
  switchCompany: vi.fn(), push: vi.fn(),
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: h.notify }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' }, switchCompany: h.switchCompany }) }));
const router = vi.hoisted(() => ({ query: { companyId: 'co-9' }, isReady: true, push: vi.fn(), replace: vi.fn() }));

import { apiFetch, ApiEnvelopeError } from '@/lib/apiFetch';
import ClientHomePage from '../../../pages/bureau/clients/[companyId]';

useApiJsonOverMock();
configure({ asyncUtilTimeout: 4000 });
const MSG = 'D2 server says no: you no longer have access to that company';
const item = { bureauId: 'b1', bureauName: 'B', companyId: 'co-9', companyName: 'Client Nine', task: 'Chase D2 debtors', detail: 'd', dueAt: null, href: '/x', severity: 'info' };

beforeEach(() => {
  vi.clearAllMocks(); router.push = h.push;
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {
    company: { id: 'co-9', name: 'Client Nine', bureauName: 'Okapi' }, metrics: { cash: 1, ar: 2, ap: 3, revenueMtd: 4, profitMtd: 5 }, workItems: [item] } }), { status: 200 }));
});
afterEach(() => { cleanup(); });

it('a refused switch shows the message and does not navigate; a good switch navigates', async () => {
  h.switchCompany.mockRejectedValue(new ApiEnvelopeError(MSG));
  render(<ClientHomePage />);
  fireEvent.click(await screen.findByText('Chase D2 debtors'));
  await waitFor(() => expect(h.notify.error).toHaveBeenCalledWith(MSG));
  expect(h.push).not.toHaveBeenCalled();
  h.switchCompany.mockResolvedValue(undefined);
  fireEvent.click(screen.getByText('Chase D2 debtors'));
  await waitFor(() => expect(h.push).toHaveBeenCalledWith('/x'));
});
