// EMP201 "Book ETI for this month" (wave 5 ET, review rounds 4 and 5): write roles only; posts the month; the result
// survives the EMP201 reload that remounts it, focus moves to it; a month that has not ended is disabled with a hint;
// the text colour passes 4.5:1 in both themes.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { Emp201BookEtiButton, resetEmp201BookEtiResult } from '@/components/accounting/sars/Emp201BookEtiButton';

let role: string | null = 'manager';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

const BOOKED = { status: 'booked', entryDate: '2026-08-31', used: 0, refund: 900 };
beforeEach(() => {
  role = 'manager';
  resetEmp201BookEtiResult();
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ success: true, data: BOOKED }));
});
afterEach(cleanup);

/** The page: a booking calls generate(), which clears the EMP201 and loads it again, so the button remounts. */
function Page({ month }: { month: string }) {
  const [generation, setGeneration] = useState(0);
  return <div key={generation}><Emp201BookEtiButton month={month} onBooked={() => setGeneration((g) => g + 1)} /></div>;
}

it('browser M1/M2: after a booking reloads the EMP201 (remount), the result stays visible and has focus', async () => {
  render(<Page month="2026-08" />);
  fireEvent.click(screen.getByRole('button', { name: 'Book ETI for this month' }));
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent(`Booked ETI for August 2026: ${formatMoney(900).replace(/\s/g, " ")} refund`);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('status')));
  const [url, init] = vi.mocked(apiFetch).mock.calls[0]!;
  expect(url).toBe('/api/accounting/sars/emp201-book-eti');
  expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ month: '2026-08' }) });
});

it('a month whose run journal books it: says so, no reload', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ success: true, data: { status: 'run_journal_in_force', entryDate: null, used: 0, refund: 0 } }));
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
  role = 'viewer';
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
