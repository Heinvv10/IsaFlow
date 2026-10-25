/** ItemPicker - active items/products, searched server-side (?q= on code or description); opening shows at most 20. */

import { RemotePicker, type PickerProps } from './RemotePicker';
import { fetchItems } from './pickerData';

export function ItemPicker({ placeholder, ...rest }: PickerProps) {
  return (
    <RemotePicker
      {...rest}
      placeholder={placeholder ?? 'Select item…'}
      createNoun="item"
      failureMessage="Could not load items - try again"
      fetchOptions={(query, signal) => fetchItems(query, signal)}
    />
  );
}
