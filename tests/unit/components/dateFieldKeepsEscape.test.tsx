// DateField's keepsEscape is opt-in (WP13c, admin audit 4.13). Without it, a DateField holding text renders no
// data-keeps-escape, and Escape inside a useFocusTrap dialog still reaches the dialog (it closes), as before the prop
// existed. With it, typed text keeps Escape for the field.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateField } from '@/components/ui/DateField';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

afterEach(() => { cleanup(); });

function TrappedDateField({ onEscape, keepsEscape }: { onEscape: () => void; keepsEscape?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onEscape);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Harness">
      <DateField label="When" value={null} onChange={vi.fn()} keepsEscape={keepsEscape} />
    </div>
  );
}

function typeAndEscape(onEscape: () => void, keepsEscape?: boolean) {
  render(<TrappedDateField onEscape={onEscape} keepsEscape={keepsEscape} />);
  const input = screen.getByLabelText('When') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '12 Dec' } });
  input.focus();
  fireEvent.keyDown(input, { key: 'Escape' });
  return input;
}

describe('DateField keepsEscape', () => {
  it('is off by default: text typed, no data-keeps-escape, Escape reaches the dialog', () => {
    const onEscape = vi.fn();
    const input = typeAndEscape(onEscape);
    expect(input.value).toBe('12 Dec');
    expect(input.hasAttribute('data-keeps-escape')).toBe(false);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('when set, typed text keeps Escape for the field', () => {
    const onEscape = vi.fn();
    const input = typeAndEscape(onEscape, true);
    expect(input.getAttribute('data-keeps-escape')).toBe('true');
    expect(onEscape).not.toHaveBeenCalled();
  });
});
