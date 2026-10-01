// VAT201SubmitModal — item 5: the manual mark-submitted gate override UI.
// When the route answers a blocking-exceptions refusal, an owner/admin sees
// the exception list AND a required-reason box and can retry with it; a
// non-owner/admin sees the refusal only, with no way to override.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VAT201SubmitModal } from '@/components/accounting/sars/VAT201SubmitModal';

const counts = {
  totalExceptions: 2, unpostedInvoiceVatCount: 2, unsupportedInputVatCount: 0,
  uncodedGlLineCount: 0, invoiceTaxCodeIssueCount: 0, invoiceGlMismatchCount: 0,
  vatOnBalanceSheetCount: 0, vatNonSupplyCount: 0,
};

describe('VAT201SubmitModal', () => {
  it('with no block, confirm is enabled once a reference is entered', () => {
    const onConfirm = vi.fn();
    render(
      <VAT201SubmitModal
        sarsRef="REF-1" submitting={false}
        onRefChange={vi.fn()} onConfirm={onConfirm} onClose={vi.fn()}
      />,
    );
    const confirm = screen.getByText('Confirm');
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('a blocked submission shows the exception list to EVERY role', () => {
    render(
      <VAT201SubmitModal
        sarsRef="REF-1" submitting={false}
        onRefChange={vi.fn()} onConfirm={vi.fn()} onClose={vi.fn()}
        blockingCounts={counts} isOwnerOrAdmin={false}
      />,
    );
    expect(screen.getByText(/2 blocking VAT exceptions/)).toBeTruthy();
    expect(screen.getByText(/unposted invoice\/bill VAT/)).toBeTruthy();
  });

  it('a non-owner/admin sees the refusal only — no reason box, confirm disabled', () => {
    render(
      <VAT201SubmitModal
        sarsRef="REF-1" submitting={false}
        onRefChange={vi.fn()} onConfirm={vi.fn()} onClose={vi.fn()}
        blockingCounts={counts} isOwnerOrAdmin={false}
      />,
    );
    expect(screen.getByText(/Only an owner or admin can override/)).toBeTruthy();
    expect(screen.queryByLabelText(/Override reason/)).toBeNull();
    expect(screen.getByText('Confirm')).toBeDisabled();
  });

  it('an owner/admin sees the required-reason box; confirm stays disabled until a reason is entered', () => {
    const onOverrideReasonChange = vi.fn();
    const { rerender } = render(
      <VAT201SubmitModal
        sarsRef="REF-1" submitting={false}
        onRefChange={vi.fn()} onConfirm={vi.fn()} onClose={vi.fn()}
        blockingCounts={counts} isOwnerOrAdmin={true}
        overrideReason="" onOverrideReasonChange={onOverrideReasonChange}
      />,
    );
    expect(screen.getByLabelText(/Override reason/)).toBeTruthy();
    expect(screen.getByText('Override and confirm')).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Override reason/), { target: { value: 'Filed manually, correcting later' } });
    expect(onOverrideReasonChange).toHaveBeenCalledWith('Filed manually, correcting later');

    rerender(
      <VAT201SubmitModal
        sarsRef="REF-1" submitting={false}
        onRefChange={vi.fn()} onConfirm={vi.fn()} onClose={vi.fn()}
        blockingCounts={counts} isOwnerOrAdmin={true}
        overrideReason="Filed manually, correcting later" onOverrideReasonChange={onOverrideReasonChange}
      />,
    );
    expect(screen.getByText('Override and confirm')).not.toBeDisabled();
  });

  it('an owner/admin retrying with a reason calls onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <VAT201SubmitModal
        sarsRef="REF-1" submitting={false}
        onRefChange={vi.fn()} onConfirm={onConfirm} onClose={vi.fn()}
        blockingCounts={counts} isOwnerOrAdmin={true}
        overrideReason="Filed manually" onOverrideReasonChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Override and confirm'));
    expect(onConfirm).toHaveBeenCalled();
  });
});
