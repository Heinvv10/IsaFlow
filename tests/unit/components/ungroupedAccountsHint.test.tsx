/**
 * UngroupedAccountsHint — the move is a chart change behind a name heuristic:
 * it is offered only to roles the grouping PUT accepts, only after the
 * accounts are listed, and it stops at the first refusal.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UngroupedAccountsHint } from '@/components/accounting/bank-transactions/UngroupedAccountsHint';
import type { UngroupedHint } from '@/components/accounting/bank-transactions/ungroupedBankHint';

const apiFetch = vi.fn();
const notify = { success: vi.fn(), error: vi.fn() };
let role: string | null = 'owner';
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/utils/toast', () => ({ notify: { success: (m: string) => notify.success(m), error: (m: string) => notify.error(m) } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role }) }));

const acct = (id: string) => ({ id, accountCode: id, accountName: `ABSA - PC : ${id}`, balance: 0, reconciledBalance: 0,
  unreconciledBalance: 0, unreconciledCount: 0, allocatedCount: 0, unallocatedCount: 0 });
const hint: UngroupedHint = { groupId: 'grp', groupName: 'ABSA Paycards', accounts: [acct('s1'), acct('s2'), acct('s3')] };
const ok = () => new Response(JSON.stringify({ success: true, data: { updated: true } }), { status: 200 });
const refused = () => new Response(JSON.stringify({ success: false, error: { message: 'Group account has its own bank transactions' } }), { status: 400 });

beforeEach(() => { role = 'owner'; apiFetch.mockReset(); notify.success.mockReset(); notify.error.mockReset(); });
afterEach(() => { cleanup(); });

it('a role the PUT refuses is told who can move them, and offered nothing', () => {
  role = 'viewer';
  render(<UngroupedAccountsHint hints={[hint]} onMoved={vi.fn()} />);
  expect(screen.getByTestId('ungrouped-hint').textContent).toContain('an owner or admin can move them');
  expect(screen.queryByTestId('ungrouped-hint-review')).toBeNull();
  expect(screen.queryByTestId('ungrouped-hint-move')).toBeNull();
});

it('while the role is still loading it neither offers the move nor says who may', () => {
  role = null;
  render(<UngroupedAccountsHint hints={[hint]} onMoved={vi.fn()} />);
  expect(screen.getByTestId('ungrouped-hint').textContent).not.toContain('owner or admin');
  expect(screen.queryByTestId('ungrouped-hint-review')).toBeNull();
});

it('nothing moves until the listed accounts are confirmed', () => {
  render(<UngroupedAccountsHint hints={[hint]} onMoved={vi.fn()} />);
  expect(screen.queryByTestId('ungrouped-hint-move')).toBeNull();
  fireEvent.click(screen.getByTestId('ungrouped-hint-review'));
  expect(screen.getByTestId('ungrouped-hint-accounts').querySelectorAll('li')).toHaveLength(3);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('confirmed: one PUT per account to the group, then a reload', async () => {
  apiFetch.mockImplementation(async () => ok());
  const onMoved = vi.fn();
  render(<UngroupedAccountsHint hints={[hint]} onMoved={onMoved} />);
  fireEvent.click(screen.getByTestId('ungrouped-hint-review'));
  fireEvent.click(screen.getByTestId('ungrouped-hint-move'));
  await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
  expect(apiFetch.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string))).toEqual(
    ['s1', 's2', 's3'].map((id) => ({ id, parentAccountId: 'grp' })));
  expect(apiFetch.mock.calls.every((c) => c[0] === '/api/accounting/bank-accounts' && (c[1] as RequestInit).method === 'PUT')).toBe(true);
  expect(notify.success).toHaveBeenCalledWith('Moved 3 accounts into ABSA Paycards');
});

it('stops at the first refusal, says why, and reloads what did move', async () => {
  apiFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refused()).mockResolvedValue(ok());
  const onMoved = vi.fn();
  render(<UngroupedAccountsHint hints={[hint]} onMoved={onMoved} />);
  fireEvent.click(screen.getByTestId('ungrouped-hint-review'));
  fireEvent.click(screen.getByTestId('ungrouped-hint-move'));
  await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(notify.error.mock.calls[0]![0]).toMatch(/^Moved 1, then stopped\. ABSA - PC : s2: .*own bank transactions/);
  expect(onMoved).toHaveBeenCalledTimes(1);
});

it('a refusal on the first account reloads nothing', async () => {
  apiFetch.mockResolvedValue(refused());
  const onMoved = vi.fn();
  render(<UngroupedAccountsHint hints={[hint]} onMoved={onMoved} />);
  fireEvent.click(screen.getByTestId('ungrouped-hint-review'));
  fireEvent.click(screen.getByTestId('ungrouped-hint-move'));
  await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(onMoved).not.toHaveBeenCalled();
});
