import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }),
}));
vi.mock('@/hooks/useVatRegistration', () => ({
  useVatRegistration: () => ({ isRegistered: true, known: true }),
}));

import { SidebarNav } from '@/components/layout/SidebarNav';

/** A touch tap: pointerdown, the compatibility mouseenter, then click. */
const tap = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { pointerType: 'touch' });
  fireEvent.mouseEnter(el);
  return fireEvent.click(el);
};

describe('SidebarNav on touch', () => {
  it.each(['banking', 'sales', 'tax', 'payroll'])('first tap on %s opens its flyout and does not navigate; the second tap follows the link', (id) => {
    render(<SidebarNav />);
    const link = screen.getByTestId(`sidebar-tab-${id}`);
    expect(tap(link)).toBe(false); // default prevented
    expect(document.body.querySelector('[style*="position: fixed"]')).not.toBeNull();
    expect(tap(link)).toBe(true);
  });

  it('a mouse click navigates at once', () => {
    render(<SidebarNav />);
    const link = screen.getByTestId('sidebar-tab-banking');
    fireEvent.pointerDown(link, { pointerType: 'mouse' });
    expect(fireEvent.click(link)).toBe(true);
  });

  it('a keyboard click navigates even after an earlier touch', () => {
    render(<SidebarNav />);
    const link = screen.getByTestId('sidebar-tab-banking');
    fireEvent.pointerDown(link, { pointerType: 'touch' });
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(fireEvent.click(link)).toBe(true);
  });
});
