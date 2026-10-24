// Select / SelectDropdown additions the pickers rely on: hint line, label classes, placeholder contrast, panel position.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import colors from 'tailwindcss/colors';
import { Select } from '@/components/ui';

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];
const noop = () => {};

afterEach(() => vi.restoreAllMocks());

describe('Select hint', () => {
  it('shows a hint under the list, but not while loading or after a failed load', () => {
    const { rerender } = render(<Select label="X" options={OPTIONS} value={null} onChange={noop} hint="Showing the first 2" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'X' }));
    expect(screen.getByRole('status').textContent).toBe('Showing the first 2');
    rerender(<Select label="X" options={OPTIONS} value={null} onChange={noop} hint="Showing the first 2" loading />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    rerender(<Select label="X" options={OPTIONS} value={null} onChange={noop} hint="Showing the first 2" loadError="no" />);
    expect(screen.queryByText('Showing the first 2')).toBeNull();
  });
});

describe('Select label classes', () => {
  it('labelClassName wins over the default size and spacing, and the default stays when absent', () => {
    const { rerender } = render(<Select label="X" options={OPTIONS} value={null} onChange={noop} />);
    expect(screen.getByText('X').className).toContain('text-sm');
    rerender(<Select label="X" options={OPTIONS} value={null} onChange={noop} labelClassName="text-xs mb-1 font-normal" />);
    const cls = screen.getByText('X').className;
    expect(cls).toContain('text-xs');
    expect(cls).not.toContain('text-sm');
    expect(cls).toContain('mb-1');
    expect(cls).not.toContain('mb-1.5');
  });
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('search box placeholder contrast', () => {
  it('is at least 4.5:1 in light (on white) and dark (on the gray-900 panel)', () => {
    render(<Select label="X" options={OPTIONS} value={null} onChange={noop} searchable />);
    fireEvent.click(screen.getByRole('combobox', { name: 'X' }));
    const cls = screen.getByRole('textbox', { name: 'Search X' }).className;
    const light = /(?<![\w:])placeholder:text-gray-(\d+)/.exec(cls)?.[1];
    const dark = /dark:placeholder:text-gray-(\d+)/.exec(cls)?.[1];
    expect(light && dark, `placeholder classes in "${cls}"`).toBeTruthy();
    const gray = colors.gray as Record<string, string>;
    expect(contrast(gray[light!]!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(gray[dark!]!, gray['900']!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('panel position', () => {
  it('follows the trigger when results arrive and move it', () => {
    let bottom = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ bottom, left: 10, width: 200, top: 0, right: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
    const { rerender } = render(<Select label="X" options={[]} value={null} onChange={noop} loading />);
    fireEvent.click(screen.getByRole('combobox', { name: 'X' }));
    const panelTop = () => (screen.getByRole('status').parentElement as HTMLElement).style.top;
    expect(panelTop()).toBe('104px');
    bottom = 160; // an error line above the field appeared while the list was loading
    rerender(<Select label="X" options={OPTIONS} value={null} onChange={noop} loading={false} />);
    expect(screen.getByRole('listbox').parentElement!.style.top).toBe('164px');
  });
});
