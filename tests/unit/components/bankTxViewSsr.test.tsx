// @vitest-environment node
/**
 * useBankTxView on the server (the page's first HTML): there is no storage, so the remembered page size is not read
 * and nothing is logged as "unreadable"; the view is measured against the default size.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn, debug: vi.fn() } }));

import { useBankTxView } from '@/components/accounting/bank-transactions/useBankTxView';
import { DEFAULT_FILTERS } from '@/components/accounting/bank-transactions/bankTxUrlState';

function Probe() {
  const router = { isReady: false, pathname: '/accounting/bank-transactions', query: {}, push: vi.fn(), replace: vi.fn() };
  const f = { values: DEFAULT_FILTERS, apply: vi.fn(), resetForAccount: vi.fn(), resetSelects: vi.fn() } as never;
  const v = useBankTxView({ router, bankAccounts: [], selectedBank: '', setSelectedBank: vi.fn(), tab: 'new', setTab: vi.fn(), page: 1, setPage: vi.fn(), f, clearSelection: vi.fn() });
  return <span>{v.restored ? 'restored' : 'not yet'}</span>;
}

describe('useBankTxView on the server', () => {
  it('renders without reading storage or warning', () => {
    expect(typeof window).toBe('undefined');
    expect(renderToString(<Probe />)).toContain('not yet');
    expect(warn).not.toHaveBeenCalled();
  });
});
