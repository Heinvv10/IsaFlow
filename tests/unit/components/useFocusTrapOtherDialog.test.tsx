/**
 * Two overlays at once: the command palette (Ctrl+K) over a drawer. Both traps listen on document, so stopPropagation
 * cannot separate them. A trap ignores keys while focus is in another dialog, or Escape closes both and Tab is pulled
 * out of the dialog on top.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

function Overlay({ name, onEscape, inner, nested }: { name: string; onEscape: () => void; inner?: boolean; nested?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onEscape);
  const controls = <><button>{`${name} first`}</button><button>{`${name} last`}</button>{nested}</>;
  // Some callers trap a panel inside their dialog element, others the dialog element itself.
  return inner
    ? <div role="dialog" aria-label={name}><div ref={ref}>{controls}</div></div>
    : <div role="dialog" aria-label={name} ref={ref}>{controls}</div>;
}

const button = (name: string) => screen.getByRole('button', { name });
afterEach(cleanup);

describe.each([['the dialog element', false], ['a panel inside it', true]])('useFocusTrap on %s', (_n, inner) => {
  it('focus in the dialog on top: Escape reaches only that one', () => {
    const below = vi.fn();
    const top = vi.fn();
    render(<><Overlay name="Drawer" onEscape={below} inner={inner} /><Overlay name="Palette" onEscape={top} /></>);
    expect(document.activeElement).toBe(button('Palette first'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  it('focus in the dialog on top: Tab is not pulled back to the one below', () => {
    render(<><Overlay name="Drawer" onEscape={() => undefined} inner={inner} /><Overlay name="Palette" onEscape={() => undefined} /></>);
    button('Palette first').focus();
    // True: nothing prevented it, so the browser moves on to the next control in the palette.
    expect(fireEvent.keyDown(button('Palette first'), { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(button('Palette first'));
    button('Palette last').focus();
    fireEvent.keyDown(button('Palette last'), { key: 'Tab' });
    expect(document.activeElement).toBe(button('Palette first'));
  });

  it('focus in its own dialog: Escape and Tab still work, for that trap alone', () => {
    const below = vi.fn();
    const top = vi.fn();
    render(<><Overlay name="Drawer" onEscape={below} inner={inner} /><Overlay name="Palette" onEscape={top} /></>);
    button('Drawer last').focus();
    fireEvent.keyDown(button('Drawer last'), { key: 'Tab' });
    expect(document.activeElement).toBe(button('Drawer first'));
    fireEvent.keyDown(button('Drawer first'), { key: 'Escape' });
    expect(below).toHaveBeenCalledTimes(1);
    expect(top).not.toHaveBeenCalled();
  });

  it('focus out of every dialog: the trap still holds it', () => {
    const escape = vi.fn();
    render(<><button>Page</button><Overlay name="Drawer" onEscape={escape} inner={inner} /></>);
    button('Page').focus();
    fireEvent.keyDown(button('Page'), { key: 'Tab' });
    expect(document.activeElement).toBe(button('Drawer first'));
    button('Page').focus();
    fireEvent.keyDown(button('Page'), { key: 'Escape' });
    expect(escape).toHaveBeenCalledTimes(1);
  });
});

it('a dialog opened inside the trapped one owns its keys too', () => {
  const outer = vi.fn();
  render(<Overlay name="Drawer" onEscape={outer} nested={<div role="dialog" aria-label="Inner"><button>Inner</button></div>} />);
  button('Inner').focus();
  fireEvent.keyDown(button('Inner'), { key: 'Escape' });
  expect(outer).not.toHaveBeenCalled();
});
