/**
 * The review notices say what the ledger could not settle, and why a return is
 * not filable; they are silent when there is nothing to say. The manual
 * mark-submitted modal repeats the filability warning without blocking.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VAT201ReviewNotices } from '@/components/accounting/sars/VAT201ReviewNotices';
import { VAT201SubmitModal } from '@/components/accounting/sars/VAT201SubmitModal';

afterEach(() => { cleanup(); });

describe('VAT201ReviewNotices', () => {
  it('renders nothing for a filable return with no warnings', () => {
    const { container } = render(<VAT201ReviewNotices warnings={[]} filability={{ filable: true, reason: null }} />);
    expect(container.textContent).toBe('');
  });

  it('shows why a return is not filable, then each warning', () => {
    render(
      <VAT201ReviewNotices
        filability={{ filable: false, reason: 'VAT201 standard-rated supplies is negative (-100.00)' }}
        warnings={[
          { code: 'uncoded-revenue-assumed-zero-rated', amount: 800, message: '800.00 of revenue with no VAT code is reported as zero-rated (field 2).' },
          { code: 'mixed-capital-and-nil-rated', amount: 300, message: '300.00 sits on a mixed journal.' },
        ]}
      />,
    );
    expect(screen.getByTestId('vat201-notice-filability').textContent).toMatch(/negative/);
    expect(screen.getByTestId('vat201-notice-uncoded-revenue-assumed-zero-rated').textContent).toMatch(/Confirm|zero-rated/);
    expect(screen.getByTestId('vat201-notice-mixed-capital-and-nil-rated')).toBeTruthy();
  });
});

describe('VAT201SubmitModal filability warning', () => {
  const props = { sarsRef: '', submitting: false, onRefChange: vi.fn(), onConfirm: vi.fn(), onClose: vi.fn() };

  it('shows the warning and still lets the user confirm', () => {
    render(<VAT201SubmitModal {...props} sarsRef="REF-1" filabilityWarning="field 1 is negative" />);
    expect(screen.getByTestId('vat201-submit-filability-warning').textContent).toMatch(/field 1 is negative/);
    expect((screen.getByRole('button', { name: /mark|submit|confirm/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows nothing when the return is filable', () => {
    render(<VAT201SubmitModal {...props} />);
    expect(screen.queryByTestId('vat201-submit-filability-warning')).toBeNull();
  });
});
