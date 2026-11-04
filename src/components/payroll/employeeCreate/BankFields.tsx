import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ACCOUNT_TYPES, type AccountType, type BankErrors, type BankForm, type BankKey } from './bankDetails';

interface Props {
  bank: BankForm;
  errors: BankErrors;
  onChange: <K extends keyof BankForm>(k: K, v: BankForm[K]) => void;
  fieldRef?: (k: BankKey) => (el: HTMLElement | null) => void;
  /** Make a field read as already known (a change keeps the bank name and type). */
  hint?: string;
}

/** The five fields, shared by the create form and the profile card. */
export function BankFields({ bank, errors, onChange, fieldRef, hint }: Props) {
  const ref = (k: BankKey) => fieldRef?.(k);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Input ref={ref('bankName')} label="Bank name *" value={bank.bankName} error={errors.bankName} autoComplete="off"
        onChange={e => onChange('bankName', e.target.value)} />
      <Input ref={ref('branchCode')} label="Branch code *" value={bank.branchCode} error={errors.branchCode} inputMode="numeric"
        placeholder="6 digits" autoComplete="off" onChange={e => onChange('branchCode', e.target.value.replace(/\s/g, ''))} />
      <Input ref={ref('accountNumber')} label="Account number *" value={bank.accountNumber} error={errors.accountNumber} inputMode="numeric"
        placeholder="6 to 16 digits" autoComplete="off" helperText={hint} onChange={e => onChange('accountNumber', e.target.value)} />
      <Select id="bank-account-type" label="Account type *" value={bank.accountType}
        options={ACCOUNT_TYPES.map(t => ({ value: t.value, label: t.label }))}
        onChange={v => onChange('accountType', (v ?? 'cheque') as AccountType)} />
      <Input ref={ref('accountHolder')} label="Account holder" value={bank.accountHolder} error={errors.accountHolder} autoComplete="off"
        helperText="Only if the account is not in the employee's own name." onChange={e => onChange('accountHolder', e.target.value)} />
    </div>
  );
}
