/**
 * The admin companies page loads its list twice on mount: once from the `[page]` effect, and again 300 ms later from the
 * search/filter debounce, which also clears the ticked rows. A test that ticks a row (or "Select all") before that second
 * load is wiped by it, so the bulk bar it waits for never appears. Wait for both list requests, then tick.
 */
import { waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type { apiFetch } from '@/lib/apiFetch';

export async function companiesListSettled(fetchMock: typeof apiFetch): Promise<void> {
  const lists = () => vi.mocked(fetchMock).mock.calls.filter(([u]) => String(u).startsWith('/api/admin/companies?')).length;
  await waitFor(() => expect(lists()).toBeGreaterThanOrEqual(2));
}
