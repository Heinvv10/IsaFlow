import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
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

describe('ExplainDrawer richer explanations', () => {
  const RICH: Explanation = {
    title: 'How was PAYE calculated?',
    asOf: '25 Oct 2026',
    lines: [
      {
        label: 'Tax on annual income',
        value: 'R 74 634.00',
        unit: 'per year',
        status: 'verified',
        source: { label: 'SARS tax tables', href: 'https://www.sars.gov.za/tax-rates', taxYear: '2026/27' },
        children: [
          { label: 'Bracket 3 base', value: 'R 42 678.00' },
          { label: 'Rate on the excess', value: '26', unit: '%', status: 'estimate', children: [{ label: 'Excess over R 237 100', value: 'R 122 900.00' }] },
        ],
      },
      { label: 'Medical credits', value: 'R 0.00', status: 'unverified', source: { label: 'Employee record', href: 'javascript:alert(1)' } },
    ],
    result: { label: 'PAYE per month', value: 'R 4 120.33', unit: 'per month' },
  };

  it('shows asOf, units, statuses in words, nested steps and the result line', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={RICH} />);
    expect(screen.getByText('As of 25 Oct 2026')).toBeTruthy();
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByText('Estimate')).toBeTruthy();
    expect(screen.getByText('Unverified')).toBeTruthy();
    expect(screen.getByText('per year')).toBeTruthy();
    expect(screen.getByText('Bracket 3 base')).toBeTruthy();
    expect(screen.getByText('Excess over R 237 100')).toBeTruthy();
    expect(screen.getAllByRole('term').map((t) => t.textContent?.replace(/Verified|Estimate|Unverified/, ''))).toEqual([
      'Tax on annual income', 'Bracket 3 base', 'Rate on the excess', 'Excess over R 237 100', 'Medical credits', 'PAYE per month',
    ]);
  });

  it('the result line is last and bold', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={RICH} />);
    const terms = screen.getAllByRole('term');
    expect(terms[terms.length - 1]?.textContent).toBe('PAYE per month');
    const value = screen.getByText('R 4 120.33');
    expect(value.className).toMatch(/font-bold/);
  });

  it('a structured source links with the tax year; an unsafe source href renders as plain text', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={RICH} />);
    const link = screen.getByRole('link', { name: /SARS tax tables \(2026\/27\)/ });
    expect(link.getAttribute('href')).toBe('https://www.sars.gov.za/tax-rates');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText(/Employee record/)).toBeTruthy();
  });

  it('a plain string source still renders as before', () => {
    render(<ExplainDrawer open onClose={() => undefined} explanation={{ title: 'T', lines: [{ label: 'L', value: 1, source: 'Payslip' }] }} />);
    expect(screen.getByText('Source: Payslip')).toBeTruthy();
  });
});

function Trap({ withButtons }: { withButtons: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, () => undefined);
  return (
    <div ref={ref} tabIndex={-1} data-testid="trap">
      {withButtons && (
        <>
          <button type="button">first</button>
          <button type="button">last</button>
        </>
      )}
    </div>
  );
}

describe('useFocusTrap', () => {
  const tab = (shift = false): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(e);
    return e;
  };

  it('Shift+Tab from the first control wraps to the last, Tab from the last wraps to the first', () => {
    render(<Trap withButtons />);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    expect(document.activeElement).toBe(first);
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('Tab between the two inner controls is left to the browser', () => {
    render(<Trap withButtons />);
    expect(tab().defaultPrevented).toBe(false);
  });

  it('a container with nothing focusable holds focus on itself and swallows Tab', () => {
    render(<Trap withButtons={false} />);
    const container = screen.getByTestId('trap');
    expect(document.activeElement).toBe(container);
    expect(tab().defaultPrevented).toBe(true);
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(container);
  });
});
