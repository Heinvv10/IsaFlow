/**
 * The rules-page editor must not offer a VAT treatment the sweep discards —
 * and must clear one that is already stored.
 *
 * `CreateRuleModal` was fixed first, but this is the OTHER rule-authoring form,
 * the one behind /accounting/bank-reconciliation/rules. Its own comment credits
 * it with producing all 37 rules that claimed input tax on restaurants, so it
 * is the primary surface rather than a corner — and it is the EDIT path, which
 * is what makes clearing rather than hiding the point: a rule saved with
 * 'standard' before K-016/K-017 loads here with the code still on it, and
 * hiding the select alone would submit it straight back.
 *
 * Rendered with a real state container, because the clearing lives in an effect
 * and only a real render runs it.
 */
import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  BankRuleForm, type BankRuleFormState, type GLAccountOption,
} from '@/components/accounting/bank-rules/BankRuleForm';

const ACCOUNTS: GLAccountOption[] = [
  { id: 'a-welfare', accountCode: '6100', accountName: 'Staff Welfare', vatInputDenied: true },
  { id: 'a-computer', accountCode: '5410', accountName: 'Computer Expenses' },
];
const SUPPLIERS = [{ id: 'sup-1', name: 'ACME' }];
const CLIENTS = [{ id: 'cli-1', name: 'Fibertime' }];

const base = (over: Partial<BankRuleFormState> = {}): BankRuleFormState => ({
  ruleName: 'r', matchField: 'description', matchType: 'contains', matchPattern: 'ACME',
  glAccountId: 'a-computer', supplierId: '', clientId: '', vatCode: '',
  descriptionTemplate: '', priority: '0', autoCreateEntry: true, ...over,
});

/** Renders with real state so the effect can write back, and exposes the form. */
function renderForm(initial: BankRuleFormState) {
  const seen: { current: BankRuleFormState } = { current: initial };
  function Harness() {
    const [form, setForm] = useState(initial);
    seen.current = form;
    return (
      <BankRuleForm
        form={form}
        setForm={setForm}
        isEditing
        busy=""
        accounts={ACCOUNTS}
        suppliers={SUPPLIERS}
        clients={CLIENTS}
        previewState={{ status: 'idle' } as never}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
  }
  render(<Harness />);
  return seen;
}

const vatSelect = () => screen.queryByLabelText('VAT code');

describe('BankRuleForm — VAT treatment is an account-rule choice only', () => {
  it('offers the select on a plain account rule', () => {
    renderForm(base({ vatCode: 'standard' }));
    expect(vatSelect()).toBeTruthy();
  });

  it.each([
    ['Supplier', { supplierId: 'sup-1' }],
    ['Customer', { clientId: 'cli-1' }],
  ])('replaces it with N/A on a %s rule', (_label, over) => {
    renderForm(base(over));
    expect(vatSelect()).toBeNull();
    expect(screen.getByText(/N\/A — settling a bill or an invoice/)).toBeTruthy();
  });

  // THE EDIT PATH. This is the case hiding alone would not have fixed.
  it('clears a stale code when an existing settlement rule is loaded', () => {
    const seen = renderForm(base({ supplierId: 'sup-1', vatCode: 'standard' }));
    expect(vatSelect()).toBeNull();
    expect(seen.current.vatCode, 're-saving must not send it back').toBe('');
  });

  it('clears it when the user turns an account rule into a supplier rule', () => {
    const seen = renderForm(base({ vatCode: 'standard' }));
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'sup-1' } });
    expect(seen.current.vatCode).toBe('');
    expect(vatSelect()).toBeNull();
  });

  it('keeps the code on an account rule, and still warns about entertainment', () => {
    const seen = renderForm(base({ glAccountId: 'a-welfare', vatCode: 'standard' }));
    expect(seen.current.vatCode).toBe('standard');
    expect(screen.getByText(/Entertainment account/)).toBeTruthy();
  });

  it('drops the entertainment warning once the rule becomes a settlement', () => {
    // The warning says "this rule will post the gross amount and report it",
    // which is about the GL account. On a supplier rule there is no GL account
    // in the posting at all, so the warning would point at nothing.
    renderForm(base({ glAccountId: 'a-welfare', vatCode: 'standard', supplierId: 'sup-1' }));
    expect(screen.queryByText(/Entertainment account/)).toBeNull();
  });
});
