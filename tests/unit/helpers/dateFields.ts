// DateField is a typed text input that commits on blur / Enter. These helpers find the report filter
// dates the way a reader does (by the DateField placeholder) and type into them.
import { fireEvent } from '@testing-library/react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const dateFieldInputs = (root: ParentNode = document): HTMLInputElement[] =>
  Array.from(root.querySelectorAll<HTMLInputElement>('input[placeholder="dd MMM yyyy"]'));

/** Type text into a DateField and leave it, which is what commits it to the page. */
export function typeDate(input: Element, text: string): void {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

/** What a DateField shows for an ISO date: '2026-10-01' -> '01 Oct 2026'. */
export const shownDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
};
