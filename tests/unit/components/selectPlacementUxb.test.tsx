/** UXB (wave 5): the kit Select opens upward near the bottom of the viewport, downward elsewhere, and keeps its side while it is searched. */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Select } from '@/components/ui/Select';

const OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
const noop = () => undefined;

function layout(top: number, viewport = 800) {
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(viewport);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ top, bottom: top + 32, left: 10, width: 200, right: 210, height: 32, x: 10, y: top, toJSON: () => ({}) }) as DOMRect);
}
const panel = () => screen.getByRole('listbox').parentElement as HTMLElement;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Select panel side', () => {
  it('opens downward with room below', () => {
    layout(100);
    render(<Select label="X" searchable options={OPTIONS} value={null} onChange={noop} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'X' }));
    expect(panel().style.top).toBe('136px');
    expect(panel().style.bottom).toBe('');
  });

  it('opens upward near the bottom: anchored by its bottom edge above the trigger', () => {
    layout(760);
    render(<Select label="X" searchable options={OPTIONS} value={null} onChange={noop} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'X' }));
    expect(panel().style.bottom).toBe('44px'); // 800 - 760 + 4
    expect(panel().style.top).toBe('');
    expect(panel().style.maxHeight).toBe('748px'); // the room above: 760 - 12
  });

  it('keeps its side while the list shrinks under a search (no flip under the pointer)', () => {
    layout(700); // 68px below the trigger, 684 above: a 12-row list opens upward, a 1-row list would fit below
    render(<Select label="X" searchable options={OPTIONS} value={null} onChange={noop} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'X' }));
    expect(panel().style.bottom).not.toBe('');
    fireEvent.change(screen.getByRole('textbox', { name: /Search/ }), { target: { value: 'Option 11' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(panel().style.bottom).not.toBe('');
    expect(panel().style.top).toBe('');
  });
});
