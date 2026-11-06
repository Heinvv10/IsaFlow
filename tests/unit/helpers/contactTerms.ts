/** A new contact must CHOOSE its payment terms (no pre-selection): the create pages' tests pick one before they save. */
import { fireEvent, screen } from '@testing-library/react';

export function chooseTerms(choice: string = 'immediate'): void {
  fireEvent.change(screen.getByLabelText(/payment terms/i), { target: { value: choice } });
}
