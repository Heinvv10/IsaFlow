// The monthly run's period is one MonthField (typed or picked), posted as { month, year}.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ push: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => ({ ...router, query: {}, isReady: true, pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
import NewRunPage from '../../../pages/payroll/runs/new';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { id: 'r1' } }), { status: 201 }));
  router.push.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const monthBox = () => screen.getByRole('textbox', { name: /Month/ }) as HTMLInputElement;
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const type = (text: string) => { fireEvent.focus(monthBox()); fireEvent.change(monthBox(), { target: { value: text } }); fireEvent.blur(monthBox()); };

describe('new payroll run: month', () => {
  it('has one month box, no separate year box or native month select', () => {
    render(<NewRunPage />);
    expect(monthBox().value).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(document.querySelector('input[type="month"], #run-month, #run-year')).toBeNull();
  });
  it('posts the typed month as { month, year }', async () => {
    render(<NewRunPage />);
    type('mar 2025');
    fireEvent.click(screen.getByRole('button', { name: /Create Run/ }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(JSON.parse(posts()[0]![1].body)).toEqual({ month: 3, year: 2025 });
  });
  it('a picked month is posted too', async () => {
    render(<NewRunPage />);
    type('1/2026');
    fireEvent.click(screen.getByRole('button', { name: 'Choose month' }));
    fireEvent.click(document.querySelector('[data-ym="2026-08"]')!);
    fireEvent.click(screen.getByRole('button', { name: /Create Run/ }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(JSON.parse(posts()[0]![1].body)).toEqual({ month: 8, year: 2026 });
  });
  it('refused or empty text posts nothing and says why', async () => {
    render(<NewRunPage />);
    type('zzz');
    fireEvent.click(screen.getByRole('button', { name: /Create Run/ }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(posts().length).toBe(0);
    type('');
    fireEvent.click(screen.getByRole('button', { name: /Create Run/ }));
    expect(posts().length).toBe(0);
  });
});
