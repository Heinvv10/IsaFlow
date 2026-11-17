/**
 * An ActionMenu inside a dialog (BankTxModalShell, the kit useFocusTrap): Escape closes the open menu only, from an item
 * or from its trigger, and the next Escape closes the dialog. useFocusTrap listens on document in the CAPTURE phase, so
 * nothing on the menu can stop it: the trap skips Escape while focus is in a menu or on an open menu's trigger, as it
 * already did for an open Select. A closed trigger, a plain field, and the Select exemption behave as before.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BankTxModalShell } from '@/components/accounting/bank-transactions/BankTxModalShell';
import { ActionMenu } from '@/components/ui/ActionMenu';

vi.mock('next/link', () => ({ default: ({ children, href, ...r }: { children: React.ReactNode; href: string }) => <a href={href} {...r}>{children}</a> }));
afterEach(cleanup);

function Harness({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <BankTxModalShell label="Split" onClose={() => setOpen(false)}>
      <input aria-label="Amount" />
      <ActionMenu triggerLabel="Line actions" items={[{ label: 'Copy', onClick: vi.fn() }, { label: 'Remove', onClick: vi.fn() }]} />
      {children}
    </BankTxModalShell>
  ) : null;
}
const dialog = () => screen.queryByRole('dialog', { name: 'Split' });
const trigger = () => screen.getByRole('button', { name: 'Line actions' });
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('an ActionMenu inside a dialog', () => {
  it('Escape on a menu item closes the menu only; the second Escape closes the dialog', () => {
    render(<Harness />);
    trigger().focus();
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy' }));
    escape();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
    escape();
    expect(dialog()).toBeNull();
  });

  it('Escape on the open trigger closes the menu only; the second Escape closes the dialog', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    trigger().focus();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    escape();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(dialog()).not.toBeNull();
    escape();
    expect(dialog()).toBeNull();
  });
});

describe('the dialog\'s Escape is otherwise unchanged', () => {
  it('from a plain field, or a CLOSED menu trigger, Escape closes the dialog', () => {
    render(<Harness />);
    screen.getByRole('textbox', { name: 'Amount' }).focus();
    escape();
    expect(dialog()).toBeNull();
    cleanup();
    render(<Harness />);
    trigger().focus();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    escape();
    expect(dialog()).toBeNull();
  });

  it('an open Select (combobox with its list) keeps its Escape: the dialog stays', () => {
    render(<Harness><button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="true" aria-controls="l" aria-label="Account">Bank</button></Harness>);
    screen.getByRole('combobox', { name: 'Account' }).focus();
    escape();
    expect(dialog()).not.toBeNull();
  });
});
