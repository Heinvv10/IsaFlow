/** DateField is a text input that commits on blur: type the text, then leave the field. */
import { fireEvent } from '@testing-library/react';

const DATE_PLACEHOLDER = 'dd MMM yyyy';

/** Every DateField text input under `root`, in document order. */
export function dateInputs(root: ParentNode = document): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(`input[placeholder="${DATE_PLACEHOLDER}"]`));
}

/** Type a date ("2026-03-01", "1 Mar 2026", "t") into a DateField input and commit it. */
export function typeDate(el: Element, text: string): void {
  fireEvent.change(el, { target: { value: text } });
  fireEvent.blur(el);
}
