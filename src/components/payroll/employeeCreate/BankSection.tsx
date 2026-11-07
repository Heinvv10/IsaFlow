import { FormSection } from '@/components/ui/FormSection';
import { BankFields } from './BankFields';
import { bankIsBlank, type BankErrors, type BankForm, type BankKey } from './bankDetails';

interface Props {
  bank: BankForm;
  errors: BankErrors;
  onChange: <K extends keyof BankForm>(k: K, v: BankForm[K]) => void;
  fieldRef: (k: BankKey) => (el: HTMLElement | null) => void;
}

/** Section 5 of the create form. Posted as a second call once the employee exists. */
export function BankSection(props: Props) {
  return (
    <FormSection number={5} title="Bank details" description="Optional. Once you type any bank detail, the bank name, branch code and account number are needed.">
      <BankFields {...props} required={!bankIsBlank(props.bank)} />
    </FormSection>
  );
}
