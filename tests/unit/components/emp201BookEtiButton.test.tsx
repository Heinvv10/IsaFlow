// EMP201 "Book ETI for this month" (wave 5 ET, review round 4 M1(c)): write roles only; posts the month; says the outcome.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { Emp201BookEtiButton } from '@/components/accounting/sars/Emp201BookEtiButton';

let role: string | null = 'manager';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

beforeEach(() => {
  role = 'manager';
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ success: true, data: { status: 'booked', entryDate: '2026-08-31' } }));
});
afterEach(cleanup);

it('a manager books the month: POST with the month, the outcome shown, the EMP201 reloaded', async () => {
  const onBooked = vi.fn();
  render(<Emp201BookEtiButton month="2026-08" onBooked={onBooked} />);
  fireEvent.click(screen.getByRole('button', { name: 'Book ETI for this month' }));
  expect(await screen.findByRole('status')).toHaveTextContent('ETI journal posted');
  const [url, init] = vi.mocked(apiFetch).mock.calls[0]!;
  expect(url).toBe('/api/accounting/sars/emp201-book-eti');
  expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ month: '2026-08' }) });
  expect(onBooked).toHaveBeenCalledTimes(1);
});

it('a month whose run journal books it: says so, no reload', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ success: true, data: { status: 'run_journal_in_force', entryDate: null } }));
  const onBooked = vi.fn();
  render(<Emp201BookEtiButton month="2026-07" onBooked={onBooked} />);
  fireEvent.click(screen.getByRole('button', { name: 'Book ETI for this month' }));
  expect(await screen.findByRole('status')).toHaveTextContent('pay run journal books its ETI');
  expect(onBooked).not.toHaveBeenCalled();
});

it('a viewer does not see it', () => {
  role = 'viewer';
  render(<Emp201BookEtiButton month="2026-08" />);
  expect(screen.queryByRole('button', { name: 'Book ETI for this month' })).toBeNull();
});
