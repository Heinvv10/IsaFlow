import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DensityToggle } from '@/components/accounting/reportControls/DensityToggle';

afterEach(cleanup);

describe('DensityToggle', () => {
  it('marks the active density pressed, so a screen reader can tell which is on', () => {
    render(<DensityToggle density="owner" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Owner' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Accountant' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the density the user picked', () => {
    const onChange = vi.fn();
    render(<DensityToggle density="owner" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accountant' }));
    expect(onChange).toHaveBeenCalledWith('accountant');
  });

  it('does not fire when the active density is clicked again', () => {
    const onChange = vi.fn();
    render(<DensityToggle density="owner" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Owner' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
