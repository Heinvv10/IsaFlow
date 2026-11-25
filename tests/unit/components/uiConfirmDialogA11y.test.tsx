// W4: the shared ui ConfirmDialog is a real modal dialog: role, aria-modal, name and description, Esc, a Tab trap, focus back to the opener.
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../../../src/components/ui/ConfirmDialog';

afterEach(cleanup);
const props = { title: 'Revoke this extension?', message: 'It will stop sending transactions.', acceptLabel: 'Revoke', onAccept: vi.fn() };

describe('ui ConfirmDialog semantics', () => {
  it('is an aria-modal dialog named by its title and described by its message', () => {
    render(<ConfirmDialog open {...props} onCancel={vi.fn()} />);
    const dlg = screen.getByRole('dialog', { name: 'Revoke this extension?' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dlg.getAttribute('aria-describedby')!)?.textContent).toBe(props.message);
  });

  it('a destructive one is an alertdialog and opens on Cancel; a default one opens on the accept button', () => {
    const { unmount } = render(<ConfirmDialog open tone="destructive" {...props} onCancel={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    unmount();
    render(<ConfirmDialog open {...props} onCancel={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Revoke/ }));
  });

  it('Escape cancels, but not while loading', () => {
    const onCancel = vi.fn();
    const { rerender } = render(<ConfirmDialog open {...props} onCancel={onCancel} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<ConfirmDialog open loading {...props} onCancel={onCancel} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Tab and Shift+Tab wrap inside the dialog, and pull focus back in when it sits outside', () => {
    render(<ConfirmDialog open {...props} onCancel={vi.fn()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const accept = screen.getByRole('button', { name: /Revoke/ });
    accept.focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(accept);
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    outside.remove();
  });

  it('focus returns to the opener when it closes', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (<><button onClick={() => setOpen(true)}>Open it</button><ConfirmDialog open={open} {...props} onCancel={() => setOpen(false)} /></>);
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
