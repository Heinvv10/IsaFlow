// Opening "create rule" on a row already allocated to a supplier must show that
// supplier even when the page's supplier list has not loaded (or failed, or was
// cut at the cap): the row's own label is the fallback, never a blank picker.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn(async () => new Response('{"data":{"matchCount":0}}', { status: 200 })) }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { CreateRuleModal } from '@/components/accounting/CreateRuleModal';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

const tx = { id: 't1', description: 'ACME PAYMENT', amount: -10 } as unknown as BankTx;
const selection: RowSelection = { type: 'supplier', entityId: 'sup-9', label: 'Acme Traders', vatCode: 'none' };
const base = { transaction: tx, bankAccountId: 'b1', glAccounts: [], selection, onClose: vi.fn(), onCreated: vi.fn() };

describe('CreateRuleModal supplier prefill', () => {
  it('shows the row label while the supplier list is empty', () => {
    render(<CreateRuleModal {...base} suppliers={[]} />);
    expect(screen.getByText('Acme Traders')).toBeTruthy();
    expect(screen.queryByText('Select Supplier...')).toBeNull();
  });
  it('prefers the listed supplier when it is loaded', () => {
    render(<CreateRuleModal {...base} suppliers={[{ id: 'sup-9', name: 'Acme Traders (Pty) Ltd', code: 'A01' }]} />);
    expect(screen.getByText('A01 Acme Traders (Pty) Ltd')).toBeTruthy();
  });
});
