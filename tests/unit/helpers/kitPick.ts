// Drive a kit Select / ContactPicker (role=combobox, options in a portal): open it by its label, click the option.
import { fireEvent, screen } from '@testing-library/react';

export const openCombobox = (label: string | RegExp) => fireEvent.click(screen.getByRole('combobox', { name: label }));

export async function pickOption(label: string | RegExp, option: string | RegExp): Promise<void> {
  openCombobox(label);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
