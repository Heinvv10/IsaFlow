import { fireEvent } from '@testing-library/react';

/** Selector for every DateField input (they are text inputs with this placeholder, not type="date"). */
export const DATE_FIELD = 'input[placeholder="dd MMM yyyy"]';

/** Types into a DateField and commits it the way a user does (DateField commits on blur). */
export function typeDate(input: Element, text: string): void {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}
