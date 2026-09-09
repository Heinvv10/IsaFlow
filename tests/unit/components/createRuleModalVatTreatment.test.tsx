/**
 * The rules modal must not offer a VAT treatment the sweep will discard.
 *
 * K-016/K-017 made a supplier or customer rule post gross with no VAT line: the
 * bill or invoice already accounted for the tax. The modal still rendered the
 * VAT Treatment buttons for every allocation type, so a user could pick
 * "Standard 15%" on a supplier rule, have it stored, have it keep displaying on
 * the rules list, and have it silently dropped at post time. The bank
 * allocation table already models the right contract — it renders a literal
 * N/A for supplier, customer and transfer rows.
 *
 * Rendered, not grepped: both halves of this are conditionals, and only a real
 * render plus a real click on the type switch exercises them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch }));
vi.mock('@/utils/toast', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { CreateRuleModal } from '@/components/accounting/CreateRuleModal';
import type { BankTx, SelectOption } from '@/components/accounting/BankTxTable';

const TX = {
  id: 'tx-1',
  description: 'ACME PAYMENT 12345',
  amount: -115,
  transactionDate: '2026-06-30',
  status: 'imported',
} as unknown as BankTx;

const SUPPLIERS: SelectOption[] = [{ id: 'sup-1', name: 'ACME' }];
const GL: SelectOption[] = [{ id: 'gl-1', code: '6000', name: 'Expense' }];

function renderModal(selection?: unknown) {
  return render(
    <CreateRuleModal
      transaction={TX}
      bankAccountId="bank-1"
      glAccounts={GL}
      suppliers={SUPPLIERS}
      clients={[]}
      bankAccounts={[]}
      selection={selection as never}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
}

/** The VAT choice buttons, which share their labels with nothing else here. */
const vatButtons = () => screen.queryAllByRole('button', { name: /Standard 15%|Zero Rated|Exempt/ });

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({
    ok: true, json: async () => ({ success: true, data: { applied: 0 } }),
  });
});

describe('CreateRuleModal — VAT treatment is an account-rule choice only', () => {
  it('offers the treatment for an account rule', () => {
    renderModal();
    expect(vatButtons().length).toBe(3);
  });

  it.each(['Supplier', 'Customer'])('replaces it with N/A on a %s rule', (label) => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(vatButtons()).toHaveLength(0);
    expect(screen.getByText(/N\/A/)).toBeTruthy();
  });

  it('drops a treatment already chosen when the type switches away', async () => {
    renderModal();
    // Pick Standard on an account rule, then make it a supplier rule.
    fireEvent.click(screen.getByRole('button', { name: 'Standard 15%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supplier' }));

    // Choose the supplier the save requires, then save.
    fireEvent.click(screen.getByRole('button', { name: /Select Supplier/ }));
    fireEvent.click(screen.getByRole('button', { name: /ACME/ }));
    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    // THE CLAIM: what reaches the API is 'none', not the stale 'standard' the
    // rules list would otherwise keep showing for a rule that ignores it.
    const body = JSON.parse(String(apiFetch.mock.calls[0]![1].body));
    expect(body.supplierId).toBe('sup-1');
    expect(body.vatCode).toBe('none');
  });

  // The effect only fires on a CHANGE of alloc type, so a modal opened straight
  // onto a supplier row never runs it. The seed has to be right on its own.
  it('seeds no treatment when it opens onto a supplier selection', async () => {
    renderModal({ type: 'supplier', entityId: 'sup-1', vatCode: 'standard' });

    expect(vatButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(JSON.parse(String(apiFetch.mock.calls[0]![1].body)).vatCode).toBe('none');
  });

  it('keeps the chosen treatment on a rule that still posts VAT', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Standard 15%' }));
    fireEvent.click(screen.getByRole('button', { name: /Select GL account|Select account/i }));
    fireEvent.click(screen.getByRole('button', { name: /Expense/ }));
    fireEvent.click(screen.getByRole('button', { name: /Create Rule/i }));
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const body = JSON.parse(String(apiFetch.mock.calls[0]![1].body));
    expect(body.vatCode).toBe('standard');
  });
});
