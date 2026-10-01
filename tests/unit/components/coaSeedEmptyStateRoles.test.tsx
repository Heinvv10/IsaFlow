/**
 * W2-28 round 9: POST /api/accounting/coa-seed is owner/admin only. The
 * dashboard's empty-chart state is shown to every role, so a manager who
 * clicked "Seed chart of accounts" got a 403. Roles the route refuses are not
 * offered the button; they are told who can do it.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CoaSeedEmptyState } from '@/components/accounting/dashboard/CoaSeedEmptyState';

const role = vi.hoisted(() => ({ current: 'owner' as string | null }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.current }) }));

afterEach(() => { cleanup(); });

it.each(['owner', 'admin'])('offers the seed button to an %s', (r) => {
  role.current = r;
  render(<CoaSeedEmptyState onSeeded={() => undefined} />);
  expect(screen.getByRole('button', { name: /seed chart of accounts/i })).toBeTruthy();
});

it.each(['manager', 'accountant', 'viewer', null])('does not offer it to %s, and says who can', (r) => {
  role.current = r;
  render(<CoaSeedEmptyState onSeeded={() => undefined} />);
  expect(screen.queryByRole('button', { name: /seed chart of accounts/i })).toBeNull();
  expect(screen.getByText(/only an owner or admin can set up the chart of accounts/i)).toBeTruthy();
});
