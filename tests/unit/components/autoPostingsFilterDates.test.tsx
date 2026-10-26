/** A nullable list filter (auto-postings From/To): refused text never changes the filter, so it never refetches. */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import AutoPostingsPage from '../../../pages/accounting/auto-postings';
import { typeDate } from '../helpers/dateFields';

const calls = (): URL[] => vi.mocked(apiFetch).mock.calls.map(([u]) => new URL(String(u), 'http://x'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ data: { entries: [], total: 0, breakdown: {} } })));
});

it('a typed From date refetches with ISO; refused text afterwards does not refetch or clear it', async () => {
  render(<AutoPostingsPage />);
  await waitFor(() => expect(calls()).toHaveLength(1));
  typeDate(screen.getByLabelText('From'), '1 Sep 2026');
  await waitFor(() => expect(calls()).toHaveLength(2));
  expect(calls()[1]!.searchParams.get('fromDate')).toBe('2026-09-01');

  typeDate(screen.getByLabelText('From'), 'zz');
  await new Promise((r) => setTimeout(r, 100));
  expect(calls()).toHaveLength(2);
  expect(screen.getByRole('alert')).toBeTruthy();
});
