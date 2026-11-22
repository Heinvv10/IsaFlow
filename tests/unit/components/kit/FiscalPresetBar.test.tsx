import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FiscalPresetBar } from '@/components/ui/FiscalPresetBar';

const NOW = () => new Date('2026-11-22T10:00:00Z');
const bar = (p: Partial<React.ComponentProps<typeof FiscalPresetBar>> = {}) =>
  render(<FiscalPresetBar label="Period" value={{ from: null, to: null }} fyStartMonth={3} getToday={NOW} onPick={() => {}} {...p} />);

describe('FiscalPresetBar', () => {
  it('hands the page the range and never touches dates itself', () => {
    const onPick = vi.fn(); bar({ onPick });
    fireEvent.click(screen.getByRole('button', { name: 'Year to date' }));
    expect(onPick).toHaveBeenCalledWith({ from: '2026-03-01', to: '2026-11-22' });
  });
  it('presses the matching preset; the custom flag overrides the match', () => {
    const { rerender } = bar({ value: { from: '2026-11-01', to: '2026-11-30' } });
    expect(screen.getByRole('button', { name: 'This month' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<FiscalPresetBar label="Period" value={{ from: '2026-11-01', to: '2026-11-30' }} custom fyStartMonth={3} getToday={NOW} onPick={() => {}} />);
    expect(screen.getByRole('button', { name: 'This month' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('Custom calls onCustom only, and a presets prop limits the pills', () => {
    const onPick = vi.fn(); const onCustom = vi.fn();
    bar({ onPick, onCustom, presets: ['this_month', 'custom'] });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(onCustom).toHaveBeenCalledTimes(1); expect(onPick).not.toHaveBeenCalled();
  });
});
