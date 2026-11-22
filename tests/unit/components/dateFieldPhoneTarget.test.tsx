// On a phone the date field must be a 44px touch target; it is 36px (h-9) at lg and up, where desktop is unchanged.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateField } from '@/components/ui/DateField';

afterEach(cleanup);

describe('DateField phone touch target', () => {
  it('is at least 44px high below lg', () => {
    render(<DateField label="When" value={null} onChange={vi.fn()} />);
    expect(screen.getByLabelText('When').className.split(/\s+/)).toContain('max-lg:min-h-11');
  });

  it('keeps the same phone target in the error state', () => {
    render(<DateField label="When" value={null} onChange={vi.fn()} error="Required" />);
    expect(screen.getByLabelText('When').className.split(/\s+/)).toContain('max-lg:min-h-11');
  });

  it('does not change the desktop height', () => {
    render(<DateField label="When" value={null} onChange={vi.fn()} />);
    const classes = screen.getByLabelText('When').className.split(/\s+/);
    expect(classes).toContain('h-9');
    expect(classes.filter((c) => c.startsWith('lg:') || /^min-h-/.test(c))).toEqual([]);
  });
});
