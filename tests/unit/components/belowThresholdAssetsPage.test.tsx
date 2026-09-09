/**
 * K-026 follow-up. The below-threshold page has to surface what the API now
 * refuses: an already-expensed asset must not offer a Post button (the POST
 * returns 409 forever), and the refusal message has to reach the user.
 */
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import Page from '../../../pages/accounting/assets/below-threshold';

const row = (id: string, number: string, expensed: boolean) => ({
  id, asset_number: number, name: `Drill ${number}`, cost: 1200, threshold: 5000,
  category_name: 'Small tools', status: 'available', created_at: '2026-01-15',
  belowThreshold: true, expensed, suggestedTreatment: 'expense',
});

function listResponse(rows: unknown[]) {
  return new Response(JSON.stringify({ success: true, data: rows }), { status: 200 });
}

it('offers Post to GL only for assets that have not been expensed', async () => {
  vi.mocked(apiFetch).mockResolvedValue(listResponse([row('a1', 'A-1', false), row('a2', 'A-2', true)]));
  render(<Page />);

  expect(await screen.findByText('A-1')).toBeTruthy();
  // One button for A-1, none for the already-expensed A-2.
  expect(screen.getAllByRole('button', { name: /Post to GL/ })).toHaveLength(1);
  expect(screen.getAllByText('Expensed')).toHaveLength(1);
});

it("shows the API's refusal message, not the generic fallback", async () => {
  const { fireEvent } = await import('@testing-library/react');
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(listResponse([row('a1', 'A-1', false)]))
    .mockResolvedValueOnce(new Response(
      JSON.stringify({ success: false, error: { code: 'CONFLICT', message: 'Asset has already been expensed' } }),
      { status: 409 },
    ));
  render(<Page />);

  fireEvent.click(await screen.findByRole('button', { name: /Post to GL/ }));
  // apiResponse nests the message under `error`; reading json.message showed the
  // generic fallback for every failure.
  expect(await screen.findByText('Asset has already been expensed')).toBeTruthy();
});
