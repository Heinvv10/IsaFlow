// UXS: Tab from an open kit Select list that sits in a Drawer. The list is portalled to <body>, outside the drawer's
// focus trap, so the trap must leave that Tab alone: the Select returns focus to its trigger and the browser then moves
// on to the NEXT control after the trigger (not back to the drawer's first control).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Drawer } from '@/components/ui/Drawer';
import { Select } from '@/components/ui/Select';

afterEach(cleanup);

function Panel({ searchable }: { searchable: boolean }) {
  return (
    <Drawer open onClose={() => undefined} title="Panel">
      <input aria-label="Before" />
      <Select label="Kind" searchable={searchable} options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]} value={null} onChange={() => undefined} />
      <input aria-label="After" />
    </Drawer>
  );
}

describe('Tab out of an open Select list inside a Drawer', () => {
  it.each([[false, 'list'], [true, 'search box']])('searchable=%s: focus in the %s, Tab is not hijacked and focus is back on the trigger', (searchable) => {
    render(<Panel searchable={searchable} />);
    const trigger = screen.getByRole('combobox', { name: 'Kind' });
    trigger.focus();
    fireEvent.click(trigger);
    const inList = screen.getByRole('listbox').closest('[data-select-listbox="true"]') ?? screen.getByRole('listbox');
    const holder = searchable ? screen.getByRole('textbox', { name: /Search Kind/ }) : (inList as HTMLElement);
    holder.focus();
    expect(document.activeElement).toBe(holder);
    const notPrevented = fireEvent.keyDown(holder, { key: 'Tab' });
    // The trap must not have moved focus to the drawer's first control, nor cancelled the key.
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
