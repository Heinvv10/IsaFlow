/**
 * The customer form's "Default revenue account" (migration 966): the kit AccountPicker, offering only what the customers
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

/**
 * `label` is the stored account's (edit page), so one no longer offered (deactivated since) still shows, marked
 * "(inactive)", and can be cleared or replaced; a pick clears it and the picker names its own choice. `usable` is the
 * single GET's flag for that stored account: false shows the warning.
 */
export function RevenueAccountField({ value, label, usable = true, onChange, error }: {
  value: string; label?: string; usable?: boolean; onChange: (id: string) => void; error?: string;
}) {
  const unusable = Boolean(value) && !usable;
  return (
    <div>
      <AccountPicker
        label="Default revenue account" labelClassName={LABEL} accountType="revenue" refine={customerRevenueAccountRows}
        value={value || null} valueLabel={value && label ? label : undefined} onChange={(id) => onChange(id ?? '')}
        clearable placeholder="Company default sales account" error={error}
      />
      {!error && (unusable
        ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">This account can no longer be used, so new invoices ignore it. Choose another or clear it.</p>
        : <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">New invoice lines for this customer start on this account (new-invoice page).</p>)}
    </div>
  );
}
