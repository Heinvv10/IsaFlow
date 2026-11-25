// AddAccountForm and CreateEntityModal share one rule for which account types need a subtype
// (subtypeRequiredFor); the Chart of Accounts form must show "Select…" for those and "None" for the rest.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { AddAccountForm, type AddAccountFormState } from '@/components/accounting/dashboard/AddAccountForm';
import type { GLAccountType } from '@/modules/accounting/types/gl.types';

const form = (accountType: GLAccountType): AddAccountFormState => ({
  accountCode: '', accountName: '', accountType, accountSubtype: '', parentAccountId: '', description: '',
});

function placeholderFor(accountType: GLAccountType) {
  const { unmount } = render(
    <AddAccountForm addForm={form(accountType)} parentOptions={[]} isSaving={false}
      onChange={vi.fn()} onCancel={vi.fn()} onSubmit={vi.fn(async () => undefined)} />,
  );
  const select = screen.getByText('Subtype').parentElement!.querySelector('select')!;
  const text = select.options[0]!.textContent;
  unmount();
  return text;
}

describe('AddAccountForm subtype placeholder', () => {
  it.each([['revenue', 'Select…'], ['expense', 'Select…'], ['asset', 'None'], ['liability', 'None'], ['equity', 'None']] as const)(
    '%s shows %s', (t, expected) => { expect(placeholderFor(t)).toBe(expected); },
  );
});
