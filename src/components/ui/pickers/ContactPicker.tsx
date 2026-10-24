/**
 * ContactPicker - customers or suppliers, searched server-side (?q=), active contacts only.
 * Opening shows at most 20 with a "type to search" hint; a preselected id is named by an id lookup, as
 * SupplierSelect does, so it displays even when it is outside that first page.
 */

import { useCallback } from 'react';
import { RemotePicker, type PickerProps } from './RemotePicker';
import { fetchContactLabel, fetchContacts, type ContactKind } from './pickerData';
import { useResolvedLabel } from './useResolvedLabel';

export interface ContactPickerProps extends PickerProps {
  kind: ContactKind;
}

export function ContactPicker({ kind, placeholder, value, valueLabel, error, ...rest }: ContactPickerProps) {
  const resolve = useCallback((id: string) => fetchContactLabel(kind, id), [kind]);
  const named = useResolvedLabel(value, valueLabel, resolve, `Could not load the ${kind} - try again`, `That ${kind} no longer exists - choose another`);

  return (
    <RemotePicker
      {...rest}
      value={value}
      valueLabel={named.label}
      error={error ?? named.error}
      placeholder={placeholder ?? `Select ${kind}…`}
      createNoun={kind}
      failureMessage={`Could not load ${kind}s - try again`}
      fetchOptions={(query, signal) => fetchContacts(kind, query, signal)}
    />
  );
}
