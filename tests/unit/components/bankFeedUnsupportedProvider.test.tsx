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
import type { BankFeedConnection } from '@/components/accounting/bankFeeds/bankFeedTypes';

function connection(provider: string): BankFeedConnection {
  return {
    id: `conn-${provider}`,
    companyId: 'company-1',
    provider,
    accountId: 'gl-1',
    accountName: 'Cheque Account',
    accountNumberMasked: null,
    externalAccountId: null,
    status: 'active',
    lastSyncAt: null,
    lastSuccessAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastSync: null,
    config: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderCard(provider: string) {
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
  return { onSync };
}

describe('BankFeedCard — providers that were never implemented', () => {
  it.each(['basiq', 'tink', 'plaid'])(
    'disables Sync and explains why for %s',
    (provider) => {
      renderCard(provider);
      const syncButton = screen.getByTitle(/not supported/i);
      expect(syncButton).toBeDisabled();
      expect(screen.getByText(/never implemented and imports nothing/i)).toBeTruthy();
    },
  );

  it('leaves the extension sync action enabled and shows no unsupported notice', () => {
    renderCard('extension');
    const syncButton = screen.getByTitle(/extension import instructions/i);
    expect(syncButton).not.toBeDisabled();
    expect(screen.queryByText(/never implemented and imports nothing/i)).toBeNull();
  });

  it('gives manual_csv no Sync action and shows no unsupported notice', () => {
    renderCard('manual_csv');
    expect(screen.queryByTitle(/not supported/i)).toBeNull();
    expect(screen.getByText('Import statement')).toBeTruthy();
    expect(screen.queryByText(/never implemented and imports nothing/i)).toBeNull();
  });
});
