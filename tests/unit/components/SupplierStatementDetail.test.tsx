import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
vi.mock('next/router', () => ({ useRouter: () => ({ query: { supplierId: '8feca858-a00a-41ff-b71d-2b77d0dcfaa5' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import Page from '../../../pages/accounting/supplier-statements/[supplierId]';
it('shows an API failure instead of claiming no transactions exist', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: 'An internal error occurred' } }), { status: 500 }));
  render(<Page />);
  expect(await screen.findByText('Failed to load supplier statement')).toBeTruthy();
  expect(screen.queryByText('No transactions found for this supplier')).toBeNull();
});
