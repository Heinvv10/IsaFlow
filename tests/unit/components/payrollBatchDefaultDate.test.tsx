/**
 * The date a batch line is given when the capturer leaves it blank. A once-off line keeps the batch month's last day
 * (paid in that month's run). A RECURRING line starts on the 1st of the next month: a recurring row starting after the
 * 27th is flagged for a manual pro-rata and refuses the run (payrollRecurringProRata), so month end would flag every
 * line of a recurring batch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'b-1' }, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }) }));

import { apiFetch } from '@/lib/apiFetch';
import { defaultBatchEffectiveFrom } from '@/components/payroll/batchDefaults';
import BatchPage from '../../../pages/payroll/batches/[id]';

useApiJsonOverMock();
const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  cleanup();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe.each(['Africa/Johannesburg', 'UTC'] as const)('defaultBatchEffectiveFrom in %s', (zone) => {
  it('once-off: the last day of the batch month', () => {
    process.env.TZ = zone;
    expect(defaultBatchEffectiveFrom({ periodYear: 2026, periodMonth: 3, isRecurring: false })).toBe('2026-03-31');
    expect(defaultBatchEffectiveFrom({ periodYear: 2028, periodMonth: 2, isRecurring: false })).toBe('2028-02-29');
    expect(defaultBatchEffectiveFrom({ periodYear: 2026, periodMonth: 11, isRecurring: false })).toBe('2026-11-30');
  });

  it('recurring: the 1st of the next month, across a year end', () => {
    process.env.TZ = zone;
    expect(defaultBatchEffectiveFrom({ periodYear: 2026, periodMonth: 3, isRecurring: true })).toBe('2026-04-01');
    expect(defaultBatchEffectiveFrom({ periodYear: 2026, periodMonth: 12, isRecurring: true })).toBe('2027-01-01');
  });
});

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

async function postedEffectiveFrom(isRecurring: boolean): Promise<unknown> {
  const posted: unknown[] = [];
  vi.mocked(apiFetch).mockReset().mockImplementation(async (u, init) => {
    const path = String(u).split('?')[0]!;
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') { posted.push(JSON.parse(String(init!.body))); return ok({ inserted: 1 }); }
    if (path === '/api/payroll/employees') return ok([{ id: 'e-1', employeeNumber: 'E1', firstName: 'Thandi', lastName: 'Mokoena' }]);
    return ok({
      batch: {
        id: 'b-1', batchType: 'component_values', componentId: 'c-1', description: 'March', periodYear: 2026, periodMonth: 3,
        isRecurring, status: 'draft', lineCount: 0, totalAmount: 0,
      },
      lines: [],
    });
  });
  render(<BatchPage />);
  const employee = await screen.findByRole('option', { name: /E1/ });
  fireEvent.change(employee.closest('select')!, { target: { value: 'e-1' } });
  fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '1500' } });
  fireEvent.click(screen.getByRole('button', { name: /add to batch/i }));
  await waitFor(() => expect(posted).toHaveLength(1));
  return (posted[0] as { lines: Array<{ effectiveFrom: string }> }).lines[0]!.effectiveFrom;
}

describe('the batch page posts the default date for a blank line', () => {
  it('a recurring batch for March 2026: 1 April', async () => {
    expect(await postedEffectiveFrom(true)).toBe('2026-04-01');
  });

  it('a once-off batch for March 2026: 31 March', async () => {
    expect(await postedEffectiveFrom(false)).toBe('2026-03-31');
  });
});
