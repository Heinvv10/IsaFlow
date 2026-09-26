// VatPeriodLocksPanel: renders active + history rows, posts the right lock
// body and surfaces a 400 message verbatim, and surfaces the 403 unlock
// refusal with the friendlier wording the route's plain "FORBIDDEN" lacks.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));

import { apiFetch } from '@/lib/apiFetch';
import { apiResponse } from '@/lib/apiResponse';
import { VatPeriodLocksPanel } from '@/components/accounting/sars/VatPeriodLocksPanel';

/** The exact body a route sends for `apiResponse.badRequest(res, message)`. */
function badRequest(message: string): Response {
  let body: unknown;
  const res = { status: () => res, json: (b: unknown) => { body = b; return res; } } as unknown as NextApiResponse;
  apiResponse.badRequest(res, message);
  return new Response(JSON.stringify(body), { status: 400 });
}

function forbidden(): Response {
  return new Response(JSON.stringify({
    success: false, error: { code: 'FORBIDDEN', message: 'This action requires admin role or higher' },
  }), { status: 403 });
}

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

const activeLock = {
  id: 'lock-1', periodStart: '2026-07-01', periodEnd: '2026-08-31',
  outputTax: 15000, inputTax: 4000, netVat: 11000, postedThrough: '2026-09-01T00:00:00.000Z',
  lockedBy: '233f3bd5-0000-4000-8000-000000000001', lockedByName: 'Jane Doe',
  actorType: 'human', lockedAt: '2026-09-02T00:00:00.000Z',
  notes: 'Filed on eFiling', active: true, unlockedAt: null, unlockedBy: null, unlockedByName: null,
  unlockReason: null,
};

const historyLock = {
  id: 'lock-0', periodStart: '2026-05-01', periodEnd: '2026-06-30',
  outputTax: 9000, inputTax: 2000, netVat: 7000, postedThrough: '2026-07-01T00:00:00.000Z',
  lockedBy: '233f3bd5-0000-4000-8000-000000000001', lockedByName: 'Jane Doe',
  actorType: 'human', lockedAt: '2026-07-02T00:00:00.000Z',
  notes: null, active: false, unlockedAt: '2026-07-10T00:00:00.000Z',
  unlockedBy: '233f3bd5-0000-4000-8000-000000000002', unlockedByName: 'John Smith',
  unlockReason: 'Correcting a duplicate invoice',
};

afterEach(() => vi.mocked(apiFetch).mockReset());

it('renders the active lock and the unlocked history row, with names not raw ids', async () => {
  vi.mocked(apiFetch).mockResolvedValue(ok({ locks: [activeLock, historyLock] }));
  render(<VatPeriodLocksPanel />);

  const activeRow = (await screen.findByText('Active')).closest('tr')!;
  expect(within(activeRow).getByText(/R\s?15\s?000,00/)).toBeTruthy();
  expect(within(activeRow).getByText(/Jane Doe/)).toBeTruthy();

  const unlockedBadge = await screen.findByText(/Unlocked on/);
  expect(unlockedBadge.textContent).toContain('John Smith');
  expect(unlockedBadge.textContent).toContain('Correcting a duplicate invoice');
  expect(screen.queryByText(/233f3bd5-/)).toBeNull();
});

it('lock submit posts the right body and shows the 400 message verbatim', async () => {
  const text = "This period fails SARS's 15% check: box 1 is out by 12.34 and box 15 by 0.00. Correct it, or lock with force to record it as filed.";
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      expect(url).toBe('/api/accounting/vat-period-locks');
      expect(JSON.parse(init.body as string)).toEqual({
        action: 'lock', periodStart: '2026-09-01', periodEnd: '2026-10-31', notes: 'Test note',
      });
      return badRequest(text);
    }
    return ok({ locks: [] });
  });
  const { container } = render(<VatPeriodLocksPanel />);
  await screen.findByText('No VAT periods have been locked yet.');

  fireEvent.change(container.querySelector('input[name="periodStart"]')!, { target: { value: '2026-09-01' } });
  fireEvent.change(container.querySelector('input[name="periodEnd"]')!, { target: { value: '2026-10-31' } });
  fireEvent.change(container.querySelector('input[name="notes"]')!, { target: { value: 'Test note' } });
  fireEvent.click(screen.getByText('Lock period'));

  expect(await screen.findByText(text)).toBeTruthy();
});

it('unlock: Confirm is disabled until a non-blank reason is entered, then shows the friendly 403 message', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return forbidden();
    return ok({ locks: [activeLock] });
  });
  render(<VatPeriodLocksPanel />);
  fireEvent.click(await screen.findByText('Unlock'));

  const confirmBtn = (await screen.findByText('Confirm unlock')).closest('button') as HTMLButtonElement;
  const textarea = screen.getByPlaceholderText(/Why is this period being unlocked/i);

  expect(confirmBtn.disabled).toBe(true);

  fireEvent.change(textarea, { target: { value: '   ' } });
  expect(confirmBtn.disabled).toBe(true);

  fireEvent.change(textarea, { target: { value: 'Amending the return' } });
  expect(confirmBtn.disabled).toBe(false);

  fireEvent.click(confirmBtn);
  expect(await screen.findByText('Only an owner or admin can unlock a VAT period.')).toBeTruthy();
});
