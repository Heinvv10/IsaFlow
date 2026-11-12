// The "+" Create menu must only link to pages that exist; a dead ?action=new param opened nothing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU_ITEMS } from '@/components/layout/CreateNewMenu';
import { PALETTE_ACTIONS } from '@/components/layout/commandActions';

const root = join(__dirname, '..', '..', '..');
const pathOf = (route: string) => route.split('?')[0];
const paletteUrl = (id: string) => PALETTE_ACTIONS.find((a) => a.id === id)?.url;

describe('Create menu routes', () => {
  it.each(MENU_ITEMS.map((i) => [i.label, i.route]))('%s resolves to an existing page', (_label, route) => {
    const p = pathOf(route);
    expect(existsSync(join(root, `pages${p}.tsx`)) || existsSync(join(root, `pages${p}/index.tsx`))).toBe(true);
  });

  it('only New Quote carries a query, and it is exactly ?action=new', () => {
    const withQuery = MENU_ITEMS.filter((i) => i.route.includes('?'));
    expect(withQuery.map((i) => i.label)).toEqual(['New Quote']);
    expect(withQuery[0].route).toBe('/accounting/customer-quotes?action=new');
  });

  it('Invoice and Bill match the command palette routes', () => {
    expect(MENU_ITEMS.find((i) => i.label === 'New Invoice')?.route).toBe(paletteUrl('new-invoice'));
    expect(MENU_ITEMS.find((i) => i.label === 'New Bill')?.route).toBe(paletteUrl('new-bill'));
  });
});
