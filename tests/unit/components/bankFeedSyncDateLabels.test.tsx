/** The extension card names each sync date once: the DateField's own label, with no duplicate caption beside it. */
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BankFeedCard } from '@/components/accounting/bankFeeds/BankFeedCard';
import type { BankFeedConnection } from '@/components/accounting/bankFeeds/bankFeedTypes';

const conn: BankFeedConnection = {
  id: 'c1', companyId: 'co', provider: 'extension', accountId: 'gl-1', accountName: 'Cheque', accountNumberMasked: null,
  externalAccountId: null, status: 'active', lastSyncAt: null, lastSuccessAt: null, lastSyncStatus: null,
  lastSyncError: null, lastSync: null, config: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

it('"Sync from" and "Sync to" each appear exactly once', () => {
  render(<BankFeedCard connection={conn} logs={[]} logsOpen={false} logsLoading={false} isSyncing={false} isDeleting={false}
    onSync={vi.fn()} onDelete={vi.fn()} onToggleLogs={vi.fn()} />);
  expect(screen.getAllByLabelText(/^Sync from/)).toHaveLength(1);
  expect(screen.getAllByLabelText(/^Sync to/)).toHaveLength(1);
  expect(screen.getAllByText(/^Sync from/)).toHaveLength(1);
});
