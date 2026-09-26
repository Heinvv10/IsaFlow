// InlineReasonForm — shared reason-collection form replacing window.prompt()
// for MarkVatDeclaredElsewhereButton, VatUnpostedInvoicesSection's bulk mark,
// and LinkTaxInvoiceButton's link/unlink.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineReasonForm } from '@/components/shared/InlineReasonForm';

describe('InlineReasonForm', () => {
  it('disables Confirm until the trimmed reason is non-empty', () => {
    render(<InlineReasonForm label="Why?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const confirmButton = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  A reason  ' } });
    expect(confirmButton.disabled).toBe(false);
  });

  it('calls onConfirm with the trimmed reason', () => {
    const onConfirm = vi.fn();
    render(<InlineReasonForm label="Why?" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  A reason  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('A reason');
  });

  it('calls onCancel and never onConfirm when Cancel is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<InlineReasonForm label="Why?" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables both buttons while busy', () => {
    render(<InlineReasonForm label="Why?" busy onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A reason' } });
    expect((screen.getByRole('button', { name: /Confirm/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Cancel') as HTMLButtonElement).disabled).toBe(true);
  });
});
