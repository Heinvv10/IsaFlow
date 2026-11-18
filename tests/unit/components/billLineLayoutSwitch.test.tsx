/**
 * The supplier-bill line table swaps a wide table for stacked cards by the width of the box it sits in. The decision
 * must not depend on which layout is showing (no flip-flop at the threshold), must switch back only with a margin,
 * and must hand focus back to the field the user was in.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';
import { coding, line, stubLayout, T, T_DIM } from '../helpers/billLineHarness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { BillLineItemsTable } from '@/components/accounting/suppliers/BillLineItemsTable';
import { nextStacked } from '@/components/accounting/suppliers/billLineLayoutRule';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); serve(on('GET', 'detail=dimensions', () => ok({ items: [] }))); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const mode = () => (screen.queryByRole('table') ? 'table' : 'cards');
function mount(lines = [line('a')], withDimensions = false) {
  const view = render(<BillLineItemsTable lines={lines} glAccounts={[]} onAdd={vi.fn()} onUpdate={vi.fn()} onRemove={vi.fn()}
    codingOptions={coding()} />);
  if (withDimensions) fireEvent.click(screen.getByRole('button', { name: 'Dimensions' }));
  return view;
}

/** Drives the width through `widths` and returns the layout after each one has settled (observer replayed). */
function modesAt(layout: ReturnType<typeof stubLayout>, widths: number[]): string[] {
  return widths.map((w) => { layout.set(w); return mode(); });
}

describe.each([[T, false], [T_DIM, true]])('threshold %i (dimensions %s)', (edge, dims) => {
  it('does not flip-flop at the threshold, going down then up', () => {
    const layout = stubLayout(edge + 200);
    mount([line('a')], dims);
    layout.set(edge + 200);
    expect(modesAt(layout, [edge + 1, edge, edge - 1, edge, edge + 1, edge + 10, edge + 23]))
      .toEqual(['table', 'table', 'cards', 'cards', 'cards', 'cards', 'cards']);
    expect(modesAt(layout, [edge + 24, edge + 25, edge, edge - 1, edge + 24])).toEqual(['table', 'table', 'table', 'cards', 'table']);
  });

  it('replaying the observer at the edge never changes the layout again (0 or 1 switches)', () => {
    const layout = stubLayout(edge + 100);
    mount([line('a')], dims);
    layout.set(edge + 100);
    for (const w of [edge - 2, edge - 1, edge, edge + 1]) {
      layout.set(w, 1);
      const seen: string[] = [mode()];
      for (let i = 0; i < 12; i++) { layout.fire(); seen.push(mode()); }
      expect(seen.filter((m, i) => i > 0 && m !== seen[i - 1]).length).toBeLessThanOrEqual(1);
    }
  });

  it('pins the threshold: just over keeps the table, just under stacks', () => {
    const layout = stubLayout(edge + 50);
    mount([line('a')], dims);
    expect(modesAt(layout, [edge + 50, edge - 1])).toEqual(['table', 'cards']);
  });
});

describe('nextStacked', () => {
  it('keeps the table while nothing is measured', () => {
    expect(nextStacked(false, 0, T)).toBe(false);
    expect(nextStacked(true, 0, T)).toBe(true);
  });
  it('stacks under the threshold, returns only with a margin, holds in between', () => {
    expect(nextStacked(false, T - 1, T)).toBe(true);
    expect(nextStacked(true, T, T)).toBe(true);
    expect(nextStacked(true, T + 23, T)).toBe(true);
    expect(nextStacked(true, T + 24, T)).toBe(false);
    expect(nextStacked(false, T, T)).toBe(false);
  });
});

describe('focus across a layout swap', () => {
  it('keeps focus and text in the description of line 2 when the Dimensions toggle moves the threshold', () => {
    const layout = stubLayout(900);
    mount([line('a', { description: 'first' }), line('b', { description: 'second line' })]);
    layout.set(900);
    expect(mode()).toBe('table');
    const before = screen.getAllByPlaceholderText('Item description')[1] as HTMLInputElement;
    before.focus();
    before.setSelectionRange(3, 6);
    expect(document.activeElement).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Dimensions' })); // threshold 820 -> 1060: 900 is now too narrow
    layout.set(900);
    expect(mode()).toBe('cards');
    const after = screen.getAllByPlaceholderText('Item description')[1] as HTMLInputElement;
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
    expect(after.value).toBe('second line');
    expect([after.selectionStart, after.selectionEnd]).toEqual([3, 6]);
  });

  it('restores the quantity field of line 1 as well, going back to the table', () => {
    const layout = stubLayout(500);
    mount([line('a'), line('b')]);
    layout.set(500);
    expect(mode()).toBe('cards');
    (screen.getByLabelText('Line 1 quantity') as HTMLInputElement).focus();
    layout.set(1000);
    expect(mode()).toBe('table');
    expect(document.activeElement).toBe(screen.getByLabelText('Line 1 quantity'));
  });

  it('does not take focus back after the user clicked away', () => {
    const layout = stubLayout(900);
    mount([line('a')]);
    layout.set(900);
    (screen.getByPlaceholderText('Item description') as HTMLInputElement).focus();
    (document.activeElement as HTMLElement).blur();
    fireEvent.mouseDown(document.body);
    layout.set(500);
    expect(mode()).toBe('cards');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('sideways-scroll hint across a swap', () => {
  it('is measured again when cards give way to a table that overflows (the observed child changed)', () => {
    const layout = stubLayout(500, 80);
    mount([line('a')]);
    layout.set(500);
    expect(mode()).toBe('cards');
    expect(screen.queryByText(/Scroll sideways/)).toBeNull();
    layout.set(1000, 1); // one observer pass: the swap itself must trigger the overflow measurement
    expect(mode()).toBe('table');
    expect(screen.getByText(/Scroll sideways/)).toBeTruthy();
  });
});
