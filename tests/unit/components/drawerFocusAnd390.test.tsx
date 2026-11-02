/**
 * Master plan U (M10, M12): the Drawer traps focus, gives it back on close, and fits a 390 px phone at every size.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Drawer } from '@/components/ui/Drawer';

function Harness({ width }: { width?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Invoice" width={width}>
        <a href="/full">Full page</a>
        <button>Last</button>
      </Drawer>
    </>
  );
}
const openIt = (width?: 'sm' | 'md' | 'lg' | 'xl') => {
  render(<Harness width={width} />);
  const trigger = screen.getByRole('button', { name: 'Open' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
};
const panelOf = () => screen.getByRole('button', { name: 'Close drawer' }).parentElement!.parentElement!;

afterEach(cleanup);

describe('Drawer', () => {
  it('moves focus inside on open', () => {
    openIt();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close drawer' }));
  });

  it('keeps Tab inside: forward from the last control wraps to the first', () => {
    openIt();
    screen.getByRole('button', { name: 'Last' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close drawer' }));
  });

  it('keeps Shift+Tab inside: back from the first control wraps to the last', () => {
    openIt();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }));
  });

  it('closes on Escape and returns focus to what opened it', () => {
    const trigger = openIt();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus when the close button closes it', () => {
    const trigger = openIt();
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(document.activeElement).toBe(trigger);
  });

  it('locks the page scroll while open and only then', () => {
    openIt();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(document.body.style.overflow).toBe('');
  });

  it.each(['sm', 'md', 'lg', 'xl'] as const)('%s: takes the full width up to its maximum, so it fits 390 px', (width) => {
    openIt(width);
    const classes = panelOf().className.split(/\s+/);
    expect(classes).toContain('w-full');
    expect(classes.some((c) => /^max-w-\[\d+px\]$/.test(c)), classes.join(' ')).toBe(true);
    expect(classes.some((c) => /^w-\[?\d/.test(c)), 'no fixed width').toBe(false);
  });
});
