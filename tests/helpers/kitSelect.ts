/** Choose an option in the kit Select: open the combobox, then click the option (waits for it to be listed). */
import { fireEvent, screen } from '@testing-library/react';

export async function pickKit(combobox: HTMLElement, option: string | RegExp): Promise<void> {
  fireEvent.click(combobox);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
