/**
 * The residential and postal address fields (wave 7 EA1, W5), shared by the profile card's editor and the create form.
 * `required`: mark the BRS-mandatory fields with an asterisk (the profile always; the create form once anything is typed).
 */
import { Input } from '@/components/ui/Input';
import { ADDRESS_FIELDS, type AddressErrors, type AddressFieldKey, type AddressForm } from './addressForm';

interface Props {
  form: AddressForm;
  errors: AddressErrors;
  required: boolean;
  onChange: (key: AddressFieldKey, path: string, value: string) => void;
  onSameChange: (same: boolean) => void;
  fieldRef: (key: AddressFieldKey) => (el: HTMLInputElement | null) => void;
}

export function AddressFields({ form, errors, required, onChange, onSameChange, fieldRef }: Props) {
  const field = (f: typeof ADDRESS_FIELDS[number]) => {
    const star = required && f.mandatory;
    return (
      <Input key={f.key} ref={fieldRef(f.key)} label={`${f.label}${star ? ' *' : ''}`} value={form[f.key]} autoComplete="off"
        aria-required={star || undefined} error={errors[f.path]?.[0]} onChange={(e) => onChange(f.key, f.path, e.target.value)} />
    );
  };
  return (
    <>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-[var(--ff-text-primary)]">Residential address</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{ADDRESS_FIELDS.filter((f) => f.part === 'res').map(field)}</div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-[var(--ff-text-primary)]">Postal address</legend>
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" checked={form.sameAsResidential} onChange={(e) => onSameChange(e.target.checked)} />
          Same as the residential address
        </label>
        {!form.sameAsResidential && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{ADDRESS_FIELDS.filter((f) => f.part === 'post').map(field)}</div>
        )}
      </fieldset>
    </>
  );
}
