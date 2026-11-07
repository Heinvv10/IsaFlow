/**
 * The customer form's "Default revenue account" (migration 965): the kit AccountPicker, offering only what the customers
 * route accepts (contactRevenueAccount.ts): active revenue accounts (the chart route returns active ones) with no
 * sub-accounts, and none that can never carry VAT. The new-invoice page starts this customer's lines on it.
 */
import { AccountPicker } from '@/components/ui/pickers/AccountPicker';
import type { AccountRow } from '@/components/ui/pickers/pickerData';
import { classifyNonSupplyAccount } from '@/modules/accounting/services/gl/nonSupplyAccounts';

/** The accounts a customer's default may be: leaves that can carry VAT (the type filter keeps revenue only). */
export function customerRevenueAccountRows(rows: AccountRow[]): AccountRow[] {
  const parents = new Set(rows.map((a) => a.parentAccountId).filter(Boolean));
  return rows.filter((a) => !parents.has(a.id) && classifyNonSupplyAccount(a.option.label) === null);
}

const LABEL = 'block text-sm font-medium text-[var(--ff-text-secondary)] mb-1';

export function RevenueAccountField({ value, onChange, error }: { value: string; onChange: (id: string) => void; error?: string }) {
  return (
    <div>
      <AccountPicker
        label="Default revenue account" labelClassName={LABEL} accountType="revenue" refine={customerRevenueAccountRows}
        value={value || null} onChange={(id) => onChange(id ?? '')} clearable placeholder="Company default sales account"
        error={error}
      />
      {!error && <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">New invoice lines for this customer start on this account.</p>}
    </div>
  );
}
