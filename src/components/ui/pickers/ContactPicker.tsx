/** ContactPicker - customers or suppliers, searched server-side (?q=). */

import { RemotePicker, type PickerProps } from './RemotePicker';
import { fetchContacts, type ContactKind } from './pickerData';

export interface ContactPickerProps extends PickerProps {
  kind: ContactKind;
}

export function ContactPicker({ kind, placeholder, ...rest }: ContactPickerProps) {
  return (
    <RemotePicker
      {...rest}
      placeholder={placeholder ?? `Select ${kind}…`}
      createNoun={kind}
      failureMessage={`Could not load ${kind}s - try again`}
      fetchOptions={(query, signal) => fetchContacts(kind, query, signal)}
    />
  );
}
