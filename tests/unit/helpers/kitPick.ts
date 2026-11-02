// Drive a kit Select / ContactPicker (role=combobox, options in a portal): open it by its label, click the option.
import { fireEvent, screen, waitFor } from '@testing-library/react';

export const openCombobox = (label: string | RegExp) => fireEvent.click(screen.getByRole('combobox', { name: label }));

export async function pickOption(label: string | RegExp, option: string | RegExp): Promise<void> {
  openCombobox(label);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

/** A form's Save waits for what it is loading (the invoice form: the picked customer), and a click on a disabled button does nothing. */
export async function clickWhenEnabled(name: string | RegExp): Promise<void> {
  const button = screen.getByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => { if (button.disabled) throw new Error(`${String(name)} is still disabled`); });
  fireEvent.click(button);
}
