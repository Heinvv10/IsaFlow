/**
 * PageHeader: a title that `truncate` cuts short carries its full text as a tooltip; one that fits carries none.
 * happy-dom does no layout, so the widths are set on the element prototype.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Users } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';

const TITLE = 'A very long page title that does not fit its column';

function setWidths(scroll: number, client: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => client });
}

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

describe('PageHeader title tooltip', () => {
  it('gives a clipped title its full text', () => {
    setWidths(400, 200);
    render(<PageHeader icon={Users} title={TITLE} />);
    expect(screen.getByRole('heading', { level: 1 }).getAttribute('title')).toBe(TITLE);
  });

  it('leaves a title that fits without a tooltip', () => {
    setWidths(200, 200);
    render(<PageHeader icon={Users} title="Customers" />);
    expect(screen.getByRole('heading', { level: 1 }).hasAttribute('title')).toBe(false);
  });
});
