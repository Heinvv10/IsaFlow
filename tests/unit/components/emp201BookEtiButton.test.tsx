// EMP201 "Book ETI for this month" (wave 5 ET, review rounds 4-6): write roles only; posts the month; the result
// survives the EMP201 refetch a booking triggers (the page keeps the section mounted), focus moves to it; it is held
// with its company and month, so another company, or a remount (another session), never sees it; a month that has
// not ended is disabled with a hint; the text colour passes 4.5:1 in both themes.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { readFileSync } from 'node:fs';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { Emp201BookEtiButton } from '@/components/accounting/sars/Emp201BookEtiButton';

const who = vi.hoisted(() => ({ role: 'manager' as string | null, company: 'c1' }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: who.role, activeCompany: { id: who.company } }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, pathname: '/', replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 'u-1', role: 'admin' } }) }));
useApiJsonOverMock();

import Emp201Page from '../../../pages/accounting/sars/emp201';

const BOOKED = { status: 'booked', entryDate: '2026-08-31', used: 0, refund: 900 };
const booked = () => `Booked ETI for August 2026: ${formatMoney(900).replace(/\s/g, ' ')} refund`;
const json = (data: unknown) => Response.json({ success: true, data });
beforeEach(() => {
  who.role = 'manager'; who.company = 'c1';
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => json(BOOKED));
});
afterEach(cleanup);

/** A page that refetches after a booking and keeps the button mounted, as emp201.tsx's generate(true) does. */
function Refetching({ month }: { month: string }) {
  const [, setGeneration] = useState(0);
  return <Emp201BookEtiButton month={month} onBooked={() => setGeneration((g) => g + 1)} />;
}

it('browser M1/M2: after a booking refetches the EMP201, the result stays visible and has focus', async () => {
  render(<Refetching month="2026-08" />);
  fireEvent.click(screen.getByRole('button', { name: 'Book ETI for this month' }));
  expect(await screen.findByRole('status')).toHaveTextContent(booked());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('status')));
  const [url, init] = vi.mocked(apiFetch).mock.calls[0]!;
  expect(url).toBe('/api/accounting/sars/emp201-book-eti');
  expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ month: '2026-08' }) });
});

it('quality M1: another company never sees the result; a remount (another session) starts with none (no module state)', async () => {
  const view = render(<Refetching month="2026-08" />);
  fireEvent.click(screen.getByRole('button', { name: 'Book ETI for this month' }));
  expect(await screen.findByRole('status')).toHaveTextContent(booked());
  who.company = 'c2';
  view.rerender(<Refetching month="2026-08" />);
  expect(screen.queryByRole('status')).toBeNull();
  who.company = 'c1';
  view.unmount();
  render(<Refetching month="2026-08" />);
  expect(screen.queryByRole('status')).toBeNull();
});

it('the EMP201 page refetches after a booking WITHOUT unmounting the ETI section, so the result stays', async () => {
  const EMP = { periodStart: '2026-08-01', periodEnd: '2026-08-31', totalPAYE: 0, totalETI: 0, payePayable: 0,
    etiCarry: { broughtForward: 900, used: 0, carriedForward: 0, refundClaimable: 900 }, etiWarnings: [],
    totalUIF_employee: 0, totalUIF_employer: 0, totalUIF: 0, totalSDL: 0, employeeCount: 0, totalTaxableRemuneration: 0, totalDeductions: 0, payrollRuns: [] };
  const gets: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('emp201-book-eti')) return json(BOOKED);
    if (u.includes('sars-emp201')) { gets.push(u); return json(EMP); }
    return json([]);
  });
  render(<Emp201Page />);
  fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Book ETI for this month' }));
  // The page defaults to the previous month, whichever that is.
  const said = /^Booked ETI for [A-Z][a-z]+ \d{4}: R.900\.00 refund/;
  expect(await screen.findByRole('status')).toHaveTextContent(said);
  await waitFor(() => expect(gets).toHaveLength(2)); // the refetch happened
  expect(screen.getByRole('status')).toHaveTextContent(said);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('status')));
});

it('a month whose run journal books it: says so, no reload', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json({ status: 'run_journal_in_force', entryDate: null, used: 0, refund: 0 }));
  const onBooked = vi.fn();
  render(<Emp201BookEtiButton month="2026-07" onBooked={onBooked} />);
  fireEvent.click(screen.getByRole('button', { name: 'Book ETI for this month' }));
  expect(await screen.findByRole('status')).toHaveTextContent("July 2026's pay run journal books its ETI");
  expect(onBooked).not.toHaveBeenCalled();
});

it('browser L3: a month that has not ended is disabled, with a hint saying when it can be booked', () => {
  render(<Emp201BookEtiButton month="2099-01" />);
  const button = screen.getByRole('button', { name: 'Book ETI for this month' });
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleDescription(/Available after .*once the month has ended/);
});

it('a viewer does not see it', () => {
  who.role = 'viewer';
  render(<Emp201BookEtiButton month="2026-08" />);
  expect(screen.queryByRole('button', { name: 'Book ETI for this month' })).toBeNull();
});

it('browser L1: the button text uses --ff-brand-eyebrow, which is at least 4.5:1 on the card in light and dark', () => {
  render(<Emp201BookEtiButton month="2026-08" />);
  expect(screen.getByRole('button', { name: 'Book ETI for this month' }).className).toContain('text-[var(--ff-brand-eyebrow)]');
  const css = readFileSync('styles/globals.css', 'utf8');
  const values = (name: string) => [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1]!);
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  const fg = values('--ff-brand-eyebrow');
  const bg = values('--ff-surface-primary');
  expect(fg.length).toBeGreaterThanOrEqual(2); // light and dark
  expect(ratio(fg[0]!, bg[0]!)).toBeGreaterThanOrEqual(4.5); // light: on the white card
  expect(ratio(fg[fg.length - 1]!, bg[bg.length - 1]!)).toBeGreaterThanOrEqual(4.5); // dark: on the slate card
});
