/**
 * RemotePicker - a labelled, searchable, keyboard-navigable single-select whose options come from `fetchOptions`.
 * The remote pickers are thin wrappers over this; it owns no endpoint knowledge and no creation form
 * (`onCreateNew(query)` is the caller's hook to open its own).
 */

import { useState } from 'react';
import { Select, type SelectOption } from '../Select';
import { useRemoteOptions, type FetchOptions } from './useRemoteOptions';

export interface PickerProps {
  /** Visible label; also the accessible name of the control and the base of the search box's name. */
  label: string;
  value: string | null;
  /** Called with the chosen id and its option, or `null`/`null` when cleared. */
  onChange: (value: string | null, option: SelectOption | null) => void;
  /** Label for `value` when it is not in the loaded options (e.g. an existing record outside the first page). */
  valueLabel?: string;
  /** Adds a "+ Create new ..." row; called with the text typed in the search box. The picker never creates anything. */
  onCreateNew?: (query: string) => void;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  error?: string;
  className?: string;
  /** Overrides the label's default classes, to match the labels of the form it sits in. */
  labelClassName?: string;
  id?: string;
}

interface RemotePickerProps extends PickerProps {
  fetchOptions: FetchOptions;
  /** Shown when the load fails with no message of its own, and when a 2xx has an unexpected shape. */
  failureMessage: string;
  /** Noun for the create row, e.g. "customer" renders `+ Create new customer "Acme"`. */
  createNoun: string;
  debounceMs?: number;
}

export function RemotePicker({
  fetchOptions, failureMessage, createNoun, debounceMs, value, valueLabel, onChange, onCreateNew, ...rest
}: RemotePickerProps) {
  const remote = useRemoteOptions(fetchOptions, failureMessage, debounceMs);
  // The last option the user picked keeps its label when a later search no longer lists it.
  const [picked, setPicked] = useState<SelectOption | null>(null);
  const fallback = valueLabel ? { value: value ?? '', label: valueLabel } : picked?.value === value ? picked : null;

  return (
    <Select
      {...rest}
      value={value}
      onChange={(v) => {
        const option = v === null ? null : remote.options.find((o) => o.value === v) ?? null;
        if (option) setPicked(option);
        onChange(v, option);
      }}
      options={remote.options}
      searchable
      onSearch={remote.onSearch}
      onOpenChange={remote.onOpenChange}
      loading={remote.loading}
      loadError={remote.error}
      hint={remote.hint}
      onCreateNew={onCreateNew}
      createLabel={`Create new ${createNoun}`}
      valueOption={value && fallback ? { value, label: fallback.label } : null}
      emptyText="No matches"
    />
  );
}
