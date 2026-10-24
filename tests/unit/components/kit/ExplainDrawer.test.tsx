import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExplainDrawer, type Explanation } from '@/components/ui/ExplainDrawer';

const EXPLANATION: Explanation = {
  title: 'How was PAYE calculated?',
  lines: [
    { label: 'Annual taxable income', formula: 'R 30 000.00 x 12', value: 'R 360 000.00', source: 'Payslip, gross pay' },
    { label: 'Tax on bracket', formula: '(360000 - 237100) x 26% + 42678', value: 74_634.4, source: 'SARS 2026/27 tables' },
    { label: 'Primary rebate', value: '-R 17 235.00' },
  ],
  caution: 'Medical aid credits are not included.',
};

describe('ExplainDrawer', () => {
  it('renders nothing while closed', () => {
    render(<ExplainDrawer open={false} onClose={() => undefined} explanation={EXPLANATION} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal dialog labelled by the explanation title', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />);
    const dialog = screen.getByRole('dialog', { name: 'How was PAYE calculated?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('renders every line verbatim: label, formula, value, source, and the caution', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />);
    expect(screen.getByText('Annual taxable income')).toBeTruthy();
    expect(screen.getByText('R 30 000.00 x 12')).toBeTruthy();
    expect(screen.getByText('R 360 000.00')).toBeTruthy();
    expect(screen.getByText('Source: Payslip, gross pay')).toBeTruthy();
    expect(screen.getByText('(360000 - 237100) x 26% + 42678')).toBeTruthy();
    expect(screen.getByText('-R 17 235.00')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('Medical aid credits are not included.');
  });

  it('never computes: a number value is shown exactly as supplied', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />);
    expect(screen.getByText('74634.4')).toBeTruthy();
  });

  it('pairs each label with its value in a description list', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />);
    expect(screen.getAllByRole('term').map((t) => t.textContent)).toEqual([
      'Annual taxable income', 'Tax on bracket', 'Primary rebate',
    ]);
    expect(screen.getAllByRole('definition')).toHaveLength(3);
  });

  it('moves focus into the dialog on open', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(<ExplainDrawer open onClose={onClose} explanation={EXPLANATION} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the close button and the backdrop close', () => {
    const onClose = vi.fn();
    const { container } = render(<ExplainDrawer open onClose={onClose} explanation={EXPLANATION} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = document.body.querySelector('[aria-hidden="true"].absolute');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(container).toBeTruthy();
  });

  it('traps Tab: from the last control it wraps to the first, and Shift+Tab wraps back', () => {
    render(
      <ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    // Only one focusable inside: Tab and Shift+Tab both stay on it.
    expect(document.activeElement).toBe(close);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('pulls focus back in when it has escaped the dialog', () => {
    render(
      <>
        <button type="button">outside</button>
        <ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />
      </>,
    );
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    outside.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('returns focus to the trigger on close and releases the scroll lock', () => {
    function Host() {
      return (
        <ExplainDrawer open={false} onClose={() => undefined} explanation={EXPLANATION} />
      );
    }
    const { rerender } = render(
      <>
        <button type="button">How was this calculated?</button>
        <Host />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'How was this calculated?' });
    trigger.focus();
    rerender(
      <>
        <button type="button">How was this calculated?</button>
        <ExplainDrawer open onClose={() => undefined} explanation={EXPLANATION} />
      </>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).not.toBe(trigger);
    rerender(
      <>
        <button type="button">How was this calculated?</button>
        <ExplainDrawer open={false} onClose={() => undefined} explanation={EXPLANATION} />
      </>,
    );
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('');
  });
});
