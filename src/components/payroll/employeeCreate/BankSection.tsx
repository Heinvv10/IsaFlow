import { FormSection } from '@/components/ui/FormSection';
import { BankFields } from './BankFields';
import type { BankErrors, BankForm, BankKey } from './bankDetails';

interface Props {
  bank: BankForm;
  errors: BankErrors;
  onChange: <K extends keyof BankForm>(k: K, v: BankForm[K]) => void;
  fieldRef: (k: BankKey) => (el: HTMLElement | null) => void;
}

/** Section 5 of the create form. Posted as a second call once the employee exists. */
export function BankSection(props: Props) {
  return (
    <FormSection number={5} title="Bank details" description="Optional. Where the salary is paid. Leave it blank and add the details on the profile later.">
      <BankFields {...props} />
    </FormSection>
  );
}
