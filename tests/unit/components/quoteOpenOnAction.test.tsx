// /accounting/customer-quotes?action=new opens the create modal, then strips the param (shallow).
import { cleanup, configure, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
const replace = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: state.query, push: vi.fn(), replace, pathname: '/accounting/customer-quotes' }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const MODAL_TEXT = /Fill in the quote details below/;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => ok({ quotes: [], total: 0, customers: [], items: [] }));
  replace.mockReset();
  state.query = {};
});
afterEach(cleanup);

describe('customer quotes ?action=new', () => {
  it('opens the modal without a click and strips the param', async () => {
    state.query = { action: 'new' };
    render(<CustomerQuotesPage />);
    expect(await screen.findByText(MODAL_TEXT)).toBeTruthy();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith({ pathname: '/accounting/customer-quotes', query: {} }, undefined, { shallow: true });
  });

  it('stays closed with no action param', async () => {
    render(<CustomerQuotesPage />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(MODAL_TEXT)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps other params when stripping action', async () => {
    state.query = { action: 'new', status: 'draft' };
    render(<CustomerQuotesPage />);
    await screen.findByText(MODAL_TEXT);
    expect(replace).toHaveBeenCalledWith({ pathname: '/accounting/customer-quotes', query: { status: 'draft' } }, undefined, { shallow: true });
  });
});
