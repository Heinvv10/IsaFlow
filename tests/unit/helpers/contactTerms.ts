import { fireEvent, screen } from '@testing-library/react';

const LABEL: Record<string, string | RegExp> = { immediate: 'Immediate', default: /^Use company default/ };

/** Pick a payment-terms choice in the kit Select (synchronous: the open list is in the document after the click). */
export function chooseTerms(choice: string = 'immediate'): void {
  fireEvent.click(screen.getByRole('combobox', { name: /payment terms/i }));
  fireEvent.click(screen.getByRole('option', { name: LABEL[choice] ?? choice }));
}
