/**
 * A bank-feed card for a provider that was never implemented must not offer a
 * Sync button that works.
 *
 * basiq/tink/plaid connections cannot be created any more, but rows created
 * before K-018 still render. Syncing one is a guaranteed failure, so the card
 * disables the button and says why.
 *
 * Rendered, not grepped: the disabled state and the notice are conditionals
 * inside the card and only a real render exercises them.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { BankFeedCard } from '@/components/accounting/bankFeeds/BankFeedCard';
import type { BankFeedConnection, Provider } from '@/components/accounting/bankFeeds/bankFeedTypes';

function connection(provider: Provider): BankFeedConnection {
  return {
    id: `conn-${provider}`,
    companyId: 'company-1',
    provider,
    accountId: 'gl-1',
    accountName: 'Cheque Account',
    externalAccountId: null,
    status: 'active',
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    config: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderCard(provider: Provider) {
  const onSync = vi.fn();
  render(
    <BankFeedCard
      connection={connection(provider)}
      logs={[]}
      logsOpen={false}
      logsLoading={false}
      isSyncing={false}
      isDeleting={false}
      onSync={onSync}
      onDelete={vi.fn()}
      onToggleLogs={vi.fn()}
    />,
  );
  // The extension card renders extra date-range sync buttons; the header
  // button is the one carrying a title.
  const syncButton = screen.getByTitle(/Sync Now|not supported/i);
  return { onSync, syncButton };
}

describe('BankFeedCard — providers that were never implemented', () => {
  it.each(['basiq', 'tink', 'plaid'] as Provider[])(
    'disables Sync and explains why for %s',
    (provider) => {
      const { syncButton } = renderCard(provider);
      expect(syncButton).toBeDisabled();
      expect(screen.getByText(/never implemented and imports nothing/i)).toBeTruthy();
    },
  );

  it.each(['manual_csv', 'extension'] as Provider[])(
    'leaves Sync enabled and shows no notice for %s',
    (provider) => {
      const { syncButton } = renderCard(provider);
      expect(syncButton).not.toBeDisabled();
      expect(screen.queryByText(/never implemented and imports nothing/i)).toBeNull();
    },
  );
});
