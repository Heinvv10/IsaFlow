// Admin nav in the light theme (admin audit 4.4): the sidebar is white in light mode, and inactive items were
// text-gray-300 / text-gray-400 with no light variant, pale grey on white. Inactive items now take their colour from
// the theme's ink tokens (--ff-text-secondary / -tertiary, dark on light and light on dark), not from a raw grey.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/admin/billing', asPath: '/admin/billing', query: {} }) }));

import { AdminNav } from '@/components/admin/AdminNav';

afterEach(cleanup);

const classes = (name: string) => screen.getByRole('link', { name }).className.split(/\s+/);
const rawText = (cls: string[]) => cls.filter((c) => /^(hover:)?text-(gray|slate|white)(-\d+)?$/.test(c));

describe('AdminNav inactive items', () => {
  it.each([
    ['Companies', 'text-ink-muted'], // top level, no children
    ['Tools', 'text-ink-muted'],     // top level with children, closed
    ['Plans', 'text-ink-faint'],     // child of the open Billing section
    ['Invoices', 'text-ink-faint'],
  ])('%s uses %s and no raw grey or white text', (name, token) => {
    render(<AdminNav />);
    const cls = classes(name);
    expect(cls).toContain(token);
    expect(cls).toContain('hover:text-ink');
    expect(rawText(cls)).toEqual([]);
  });

  it('the active item keeps its brand fill', () => {
    render(<AdminNav />);
    expect(classes('Billing')).toContain('bg-brand-600');
  });
});
