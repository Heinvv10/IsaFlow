// The shared settings Toggle: its row is a 44px tap target on phones (the label wraps the switch, so a tap anywhere
// on the row toggles it); desktop untouched. A row, not an oversized hit box, so stacked toggles never overlap.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toggle } from '@/components/accounting/settings/settingsTypes';

afterEach(cleanup);
const classes = (el: Element | null) => (el?.className ?? '').split(/\s+/);

describe('Toggle touch target', () => {
  it('makes the row 44px high below lg: 20px switch + 2 x py-3', () => {
    render(<Toggle checked={false} onChange={vi.fn()} label="Enabled" />);
    const row = screen.getByRole('switch').closest('label');
    expect(classes(row)).toContain('max-lg:py-3');
    expect(classes(screen.getByRole('switch'))).toEqual(expect.arrayContaining(['h-5', 'w-9']));
  });

  it('keeps the desktop row: py-1 and no unscoped extra padding or pseudo-element', () => {
    render(<Toggle checked onChange={vi.fn()} label="Enabled" />);
    const row = screen.getByRole('switch').closest('label');
    expect(classes(row)).toContain('py-1');
    expect(classes(row).filter(c => /^(py-[2-9]|lg:|min-h-)/.test(c))).toEqual([]);
    expect(classes(screen.getByRole('switch')).filter(c => c.includes('before:'))).toEqual([]);
  });

  it('still toggles from the switch and from its label text', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Enabled" />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByText('Enabled'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, true);
  });
});
