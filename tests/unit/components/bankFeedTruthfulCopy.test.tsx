import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { PROVIDER_LABELS, PROVIDER_DESCRIPTIONS, providerLabel } from '@/components/accounting/bankFeeds/bankFeedTypes';
import { AddConnectionModal } from '@/components/accounting/bankFeeds/AddConnectionModal';

describe('bank feed copy is truthful', () => {
  it('offers no provider IsaFlow does not have', () => {
    const all = JSON.stringify({ PROVIDER_LABELS, PROVIDER_DESCRIPTIONS });
    expect(all).not.toMatch(/Basiq|Tink|Plaid|Stitch/i);
    expect(all).not.toMatch(/automatic/i);
    expect(PROVIDER_DESCRIPTIONS.extension).toMatch(/user-operated|you run it/i);
  });
  it('labels a legacy provider as unsupported without naming it as an offering', () => {
    expect(providerLabel('basiq')).toBe('Unsupported legacy connection (basiq)');
  });
  it('the add-connection modal renders no unsupported option', () => {
    const { container } = render(<AddConnectionModal bankAccounts={[]} onClose={() => {}} onCreated={() => {}} />);
    expect(container.textContent ?? '').not.toMatch(/Basiq|Tink|Plaid|Stitch|automatic/i);
  });
});
