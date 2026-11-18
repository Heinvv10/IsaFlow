/** The page's modal host (BankTxPageModals) keeps the last-click tracker alive while it is mounted, and only then. */
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/components/accounting/bank-transactions/BankTxModals', () => ({ BankTxModals: () => null }));
import { BankTxPageModals } from '@/components/accounting/bank-transactions/BankTxPageModals';

afterEach(cleanup);
it('adds one document click listener on mount and removes it on unmount', () => {
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
  const n = (spy: typeof add) => spy.mock.calls.filter(c => c[0] === 'click').length;
  const { unmount } = render(<BankTxPageModals {...({ m: {}, actions: {}, afterMutation: vi.fn(), transactions: [] } as never)} />);
  expect(n(add)).toBe(1);
  unmount();
  expect(n(remove)).toBe(1);
  add.mockRestore(); remove.mockRestore();
});
