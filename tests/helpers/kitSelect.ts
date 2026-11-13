/** Drive the kit Select. Every helper first proves the control IS the kit trigger, so a native <select> cannot pass. */
import { fireEvent, screen } from '@testing-library/react';
import { expect } from 'vitest';

export function expectKitTrigger(el: HTMLElement): void {
  expect(el.tagName).not.toBe('SELECT');
  expect(el.getAttribute('aria-haspopup')).toBe('listbox');
}

/** Open the kit Select's list. */
export function openKit(combobox: HTMLElement): void {
  expectKitTrigger(combobox);
  fireEvent.click(combobox);
}

/** Choose an option: open the combobox, then click the option (waits for it to be listed). */
export async function pickKit(combobox: HTMLElement, option: string | RegExp): Promise<void> {
  openKit(combobox);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
