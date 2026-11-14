// Admin nav in the light theme (WP13, admin audit 4.4): the sidebar is white in light mode, so an inactive item
// needs a dark text colour there. Inactive items were text-gray-300 / -400 with no light variant: pale grey on
// white. Every unprefixed text colour on an inactive item must be a dark grey (600+); light greys only under dark:.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/admin/billing', asPath: '/admin/billing', query: {} }) }));

import { AdminNav } from '@/components/admin/AdminNav';

const lightTextShades = (className: string) => className.split(/\s+/)
  .filter((c) => /^text-gray-\d+$/.test(c))
  .map((c) => Number(c.replace('text-gray-', '')));

describe('AdminNav light theme', () => {
  it('inactive top-level and child items use a dark grey outside dark mode', () => {
    render(<AdminNav />);
    // Companies: inactive top level. Plans: inactive child of the open Billing section.
    for (const name of ['Companies', 'Settings', 'Plans', 'Invoices']) {
      const shades = lightTextShades(screen.getByRole('link', { name }).className);
      expect(shades.length, name).toBeGreaterThan(0);
      expect(shades.every((n) => n >= 600), `${name}: ${shades.join(',')}`).toBe(true);
    }
  });
});
