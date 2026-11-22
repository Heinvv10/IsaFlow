// The shared settings Toggle: a 44px tap area on phones without changing its layout box; desktop untouched.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toggle } from '@/components/accounting/settings/settingsTypes';

afterEach(cleanup);
const classes = (el: HTMLElement) => el.className.split(/\s+/);

describe('Toggle touch target', () => {
  it('extends the switch hit area to 44px below lg with a pseudo-element, not by resizing it', () => {
    render(<Toggle checked={false} onChange={vi.fn()} label="Enabled" />);
    const sw = screen.getByRole('switch');
    // h-5 (20px) + 2 * 12px = 44px tall; w-9 (36px) + 2 * 4px = 44px wide. The switch itself keeps h-5 w-9.
    for (const c of ['max-lg:before:absolute', 'max-lg:before:-inset-y-3', 'max-lg:before:-inset-x-1']) expect(classes(sw)).toContain(c);
    expect(classes(sw)).toEqual(expect.arrayContaining(['relative', 'h-5', 'w-9']));
  });

  it('adds nothing for desktop', () => {
    render(<Toggle checked onChange={vi.fn()} label="Enabled" />);
    const extra = classes(screen.getByRole('switch')).filter(c => c.includes('before:') && !c.startsWith('max-lg:'));
    expect(extra).toEqual([]);
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
