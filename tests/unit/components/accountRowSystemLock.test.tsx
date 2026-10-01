/**
 * W2-28 round 10: a role holder's row in the chart of accounts showed a bare
 * lock icon. It now says what the lock means and where the role is changed.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountRow } from '@/components/accounting/dashboard/AccountRow';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

const account = (over: Record<string, unknown>) => ({ id: 'a', accountCode: '1110', accountName: 'Bank', accountType: 'asset',
  normalBalance: 'debit', level: 3, isActive: true, isSystemAccount: true, children: [], ...over }) as never;
const row = (over: Record<string, unknown>) => render(
  <table><tbody>
    <AccountRow account={account(over)} level={0} viewMode="flat" parentOptions={[]} onUpdate={async () => undefined} onDelete={async () => undefined} />
  </tbody></table>);

afterEach(() => { cleanup(); });

it('a role holder says which role it holds and where to change it', () => {
  row({ accountSubtype: 'retained_earnings' });
  expect(screen.getByRole('img', { name: 'System account — holds the retained earnings role; change it in Default Accounts' })).toBeTruthy();
  expect(screen.getByTitle(/holds the retained earnings role; change it in Default Accounts/)).toBeTruthy();
});

it('a system account that holds no role says so without naming one', () => {
  row({ accountSubtype: 'equity' });
  expect(screen.getByRole('img', { name: 'System account — it cannot be deleted or deactivated here' })).toBeTruthy();
});

it('an ordinary account shows no lock', () => {
  row({ isSystemAccount: false, accountSubtype: null });
  expect(screen.queryByRole('img', { name: /system account/i })).toBeNull();
});
