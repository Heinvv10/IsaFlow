/**
 * #1400 review: the admin lists' pager chevrons are icon-only, so they carry names ("Previous page", "Next page").
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminPager } from '@/components/admin/AdminPager';

afterEach(cleanup);

describe('AdminPager', () => {
  it('names its chevrons, disables them at the ends, and steps the page', () => {
    const setPage = vi.fn();
    const { rerender } = render(<AdminPager page={1} totalPages={3} setPage={setPage} />);
    const prev = screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    const step = setPage.mock.calls[0]![0] as (p: number) => number;
    expect(step(1)).toBe(2);
    rerender(<AdminPager page={3} totalPages={3} setPage={setPage} />);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect((setPage.mock.calls[1]![0] as (p: number) => number)(3)).toBe(2);
    expect(screen.getByText('Page 3 of 3')).toBeTruthy();
  });
});
