// Returning from an invoice restores the aging view: the row named in the query
// re-expands and scrolls into view once, a valid as-at date is handed back,
// and malformed values are ignored.
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router: { isReady: boolean; query: Record<string, string> } = { isReady: true, query: {} };
vi.mock('next/router', () => ({ useRouter: () => router }));

import { useAgingReturn } from '@/components/accounting/useAgingReturn';

const A = '3f8a1c2e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const B = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0';
const scroll = vi.fn();

function Harness({ rowsReady = true, onAsAtDate }: { rowsReady?: boolean; onAsAtDate?: (d: string) => void }) {
  const { restored, expandedId, rowProps } = useAgingReturn({ entityParam: 'customer', rowsReady, onAsAtDate });
  return (
    <table><tbody>
      {[A, B].map(id => <tr key={id} {...rowProps(id)}><td>{id === A ? 'row A' : 'row B'}</td></tr>)}
      <tr><td data-testid="state">{`${restored}|${expandedId ?? 'none'}`}</td></tr>
    </tbody></table>
  );
}

const state = () => screen.getByTestId('state').textContent;

beforeEach(() => { Element.prototype.scrollIntoView = scroll; });
afterEach(() => { scroll.mockReset(); router.isReady = true; router.query = {}; });

describe('useAgingReturn', () => {
  it('re-expands and scrolls to the returned row, and hands back the as-at date', () => {
    router.query = { customer: A, as_at_date: '2026-06-30' };
    const onAsAtDate = vi.fn();
    render(<Harness onAsAtDate={onAsAtDate} />);

    expect(state()).toBe(`true|${A}`);
    expect(onAsAtDate).toHaveBeenCalledWith('2026-06-30');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(screen.getByText('row A').closest('tr'));
    expect(screen.getByText('row A').closest('tr')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('waits for the router and the rows before restoring and scrolling', () => {
    router.isReady = false;
    router.query = { customer: A };
    const { rerender } = render(<Harness rowsReady={false} />);
    expect(state()).toBe('false|none');

    router.isReady = true;
    rerender(<Harness rowsReady={false} />);
    expect(state()).toBe(`true|${A}`);
    expect(scroll).not.toHaveBeenCalled();

    rerender(<Harness rowsReady />);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed entity or date but still marks itself restored', () => {
    router.query = { customer: '<img src=x>', as_at_date: '30/06/2026' };
    const onAsAtDate = vi.fn();
    render(<Harness onAsAtDate={onAsAtDate} />);
    expect(state()).toBe('true|none');
    expect(onAsAtDate).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('does not re-expand after the user collapses the restored row', () => {
    router.query = { customer: A };
    render(<Harness />);
    fireEvent.click(screen.getByText('row A'));
    expect(state()).toBe('true|none');
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('toggles rows by click and by Enter/Space from the keyboard', () => {
    render(<Harness />);
    const rowB = screen.getByText('row B').closest('tr')!;
    fireEvent.click(rowB);
    expect(state()).toBe(`true|${B}`);
    fireEvent.keyDown(rowB, { key: 'Enter' });
    expect(state()).toBe('true|none');
    fireEvent.keyDown(rowB, { key: ' ' });
    expect(state()).toBe(`true|${B}`);
    fireEvent.keyDown(rowB, { key: 'a' });
    expect(state()).toBe(`true|${B}`);
  });
});
