/**
 * The admin dashboard's "Trials Expiring Soon" card (WP14c split it out of
 * pages/admin/index.tsx): the extend button, its in-flight state, the
 * days-left badge thresholds and the Upgrade link. The page's load and
 * extend calls are covered in d2R3a6Admin.test.tsx.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrialsExpiringSoon, type TrialRow } from '@/components/admin/dashboard/TrialsExpiringSoon';

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) =>
    <a href={href} className={className}>{children}</a>,
}));

const trial = (id: string, days: number): TrialRow => ({
  id, name: `Co ${id}`, trial_ends_at: '2026-11-20T00:00:00Z', user_count: 3, days_left: days, status: 'trial',
});
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

afterEach(() => { cleanup(); });

describe('TrialsExpiringSoon', () => {
  it('"+7 days" calls onExtend with that trial\'s company id', () => {
    const onExtend = vi.fn();
    render(<TrialsExpiringSoon trials={[trial('c1', 3), trial('c2', 4)]} extendingId={null} onExtend={onExtend} />);
    fireEvent.click(within(rowOf('Co c2')).getByRole('button', { name: '+7 days' }));
    expect(onExtend).toHaveBeenCalledTimes(1);
    expect(onExtend).toHaveBeenCalledWith('c2');
  });

  it('the trial being extended has a disabled button with a spinner; the others stay enabled', () => {
    const onExtend = vi.fn();
    render(<TrialsExpiringSoon trials={[trial('c1', 3), trial('c2', 4)]} extendingId="c1" onExtend={onExtend} />);
    const busy = within(rowOf('Co c1')).getByRole('button', { name: '+7 days' }) as HTMLButtonElement;
    const idle = within(rowOf('Co c2')).getByRole('button', { name: '+7 days' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.querySelector('.animate-spin')).not.toBeNull();
    expect(idle.disabled).toBe(false);
    expect(idle.querySelector('.animate-spin')).toBeNull();
    fireEvent.click(busy);
    expect(onExtend).not.toHaveBeenCalled();
  });

  it('days-left badge: <=0 Expired, <=2 red, <=5 orange, otherwise yellow', () => {
    const days = { a: 0, b: -1, c: 1, d: 2, e: 3, f: 5, g: 6 };
    render(<TrialsExpiringSoon trials={Object.entries(days).map(([id, n]) => trial(id, n))} extendingId={null} onExtend={vi.fn()} />);
    const badge = (id: string) => {
      const cell = rowOf(`Co ${id}`).querySelectorAll('td')[1]!;
      const spans = cell.querySelectorAll('span');
      return spans[spans.length - 1]!;
    };
    const shade = (id: string) => (badge(id).className.match(/bg-(gray-200|red-500|orange-500|yellow-500)/) ?? [])[1];
    expect([badge('a').textContent, shade('a')]).toEqual(['Expired', 'gray-200']);
    expect([badge('b').textContent, shade('b')]).toEqual(['Expired', 'gray-200']);
    expect([badge('c').textContent, shade('c')]).toEqual(['1d', 'red-500']);
    expect([badge('d').textContent, shade('d')]).toEqual(['2d', 'red-500']);
    expect([badge('e').textContent, shade('e')]).toEqual(['3d', 'orange-500']);
    expect([badge('f').textContent, shade('f')]).toEqual(['5d', 'orange-500']);
    expect([badge('g').textContent, shade('g')]).toEqual(['6d', 'yellow-500']);
  });

  it('Upgrade links to the company\'s admin page; the header links to all trials and counts them', () => {
    render(<TrialsExpiringSoon trials={[trial('c9', 3), trial('c8', 4)]} extendingId={null} onExtend={vi.fn()} />);
    expect(within(rowOf('Co c9')).getByText('Upgrade').closest('a')?.getAttribute('href')).toBe('/admin/companies/c9');
    expect(screen.getByText('View All Trials').closest('a')?.getAttribute('href')).toBe('/admin/trials');
    expect(screen.getByText('Trials Expiring Soon').parentElement?.textContent).toContain('2');
  });
});
