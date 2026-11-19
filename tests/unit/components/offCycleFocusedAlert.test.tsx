/**
 * Wave 6 OC, UI review #1620 M1: after a failed Create the error is scrolled into view and takes focus (role="alert"),
 * so it is never left clipped under the sticky header with focus still on the button. A new message moves it again.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FocusedAlert } from '@/components/ui/FocusedAlert';

describe('FocusedAlert', () => {
  it('renders nothing without a message', () => {
    const { container } = render(<FocusedAlert message="" />);
    expect(container.innerHTML).toBe('');
  });

  it('scrolls a new message into view and moves focus to it; a changed message does it again', () => {
    const scroll = vi.fn();
    const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = scroll;
    try {
      const { rerender } = render(<><button type="button">Create off-cycle run</button><FocusedAlert message="" /></>);
      screen.getByRole('button').focus();
      rerender(<><button type="button">Create off-cycle run</button><FocusedAlert message="Choose at least one employee." /></>);
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe('Choose at least one employee.');
      expect(document.activeElement).toBe(alert);
      expect(scroll).toHaveBeenCalledTimes(1);
      screen.getByRole('button').focus();
      rerender(<><button type="button">Create off-cycle run</button><FocusedAlert message="The pay date 16 Nov 2026 has passed." /></>);
      expect(document.activeElement).toBe(screen.getByRole('alert'));
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      proto.scrollIntoView = had;
    }
  });
});
