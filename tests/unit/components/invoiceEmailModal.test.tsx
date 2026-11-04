/**
 * PR S review (breaker): InvoiceEmailModal is a real dialog (role, aria-modal, labelled, focus moved in and kept in,
 * the address field labelled, the X named), Send cannot go twice (disabled while sending and once sent), and the form
 * cannot be closed while a send is out (Close, X, Escape and the backdrop all wait).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvoiceEmailModal } from '@/components/invoices/InvoiceEmailModal';

afterEach(cleanup);

const props = (over: Partial<Parameters<typeof InvoiceEmailModal>[0]> = {}) => ({
  open: true, invoiceNumber: 'INV-1', emailTo: 'a@b.example', emailSending: false, emailSuccess: '',
  onEmailToChange: vi.fn(), onSend: vi.fn(), onClose: vi.fn(), ...over,
});

describe('InvoiceEmailModal', () => {
  it('is a labelled modal dialog with a labelled address field and a named X, and takes the focus', () => {
    render(<InvoiceEmailModal {...props()} />);
    const dialog = screen.getByRole('dialog', { name: 'Email Invoice' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect((screen.getByLabelText('Recipient Email') as HTMLInputElement).value).toBe('a@b.example');
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps Tab inside the dialog', () => {
    render(<InvoiceEmailModal {...props()} />);
    const send = screen.getByRole('button', { name: /send email/i });
    send.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(send);
  });

  it('Send is disabled once the invoice was emailed', () => {
    render(<InvoiceEmailModal {...props({ emailSuccess: 'Invoice emailed successfully!' })} />);
    expect(screen.getByRole('button', { name: /send email/i })).toBeDisabled();
  });

  it('while sending, Send is disabled and nothing closes it: Close, X, Escape, the backdrop', () => {
    const p = props({ emailSending: true });
    render(<InvoiceEmailModal {...p} />);
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('not sending, the backdrop and Escape close it', () => {
    const p = props();
    render(<InvoiceEmailModal {...p} />);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});
