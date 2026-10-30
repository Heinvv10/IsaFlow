/**
 * The override note (P4 spec §7): placed in the viewport, it follows the cell when the page (or
 * the grid's scroll box) scrolls or the window resizes; Reset is disabled while its reset runs.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverrideMark } from '@/components/accounting/budgets/drivers/OverrideMark';

afterEach(cleanup);

const rect = (top: number, right: number) => ({ top, bottom: top + 12, left: right - 12, right, width: 12, height: 12, x: right - 12, y: top, toJSON: () => ({}) }) as DOMRect;

describe('OverrideMark', () => {
  it('the open note moves with its mark on scroll and resize', () => {
    let top = 100;
    render(<OverrideMark focused valueOf={() => 38_000} onReset={null} />);
    const mark = screen.getByTestId('override-mark');
    vi.spyOn(mark, 'getBoundingClientRect').mockImplementation(() => rect(top, 600));
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(screen.getByTestId('override-note').style.top).toBe('112px');
    top = 40;
    act(() => { document.body.dispatchEvent(new Event('scroll')); });
    expect(screen.getByTestId('override-note').style.top).toBe('52px');
    top = 300;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(screen.getByTestId('override-note').style.top).toBe('312px');
  });

  it('Reset is disabled until the reset it started settles', async () => {
    let release: () => void = () => undefined;
    const onReset = vi.fn(() => new Promise<void>((r) => { release = r; }));
    render(<OverrideMark focused valueOf={() => null} onReset={onReset} />);
    fireEvent.click(screen.getByTestId('override-reset'));
    expect(screen.getByTestId('override-reset')).toBeDisabled();
    fireEvent.click(screen.getByTestId('override-reset'));
    expect(onReset).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    expect(screen.getByTestId('override-reset')).not.toBeDisabled();
  });
});
