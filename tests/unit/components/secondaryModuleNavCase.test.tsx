/**
 * The section bar's tabs and menu items read as written in the nav config (sentence case, like the main-row menus):
 * only the small module label beside them is set in capitals. The capitals used to sit on the wrapper, so every
 * dropdown item inherited `text-transform: uppercase`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting/items', asPath: '/accounting/items', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { SecondaryModuleNav } from '@/components/accounting/SecondaryModuleNav';

afterEach(cleanup);

/** Classes on `el` and on every ancestor up to the rendered root. */
function inheritedClasses(el: Element, root: Element): string[] {
  const out: string[] = [];
  for (let n: Element | null = el; n && n !== root.parentElement; n = n.parentElement) out.push(...n.classList);
  return out;
}

describe('SecondaryModuleNav text case', () => {
  it('menu items and tabs inherit no uppercase or letter-spacing; the module label keeps them', () => {
    const { container } = render(<SecondaryModuleNav moduleId="inventory" />);
    const nav = screen.getByRole('navigation', { name: 'Inventory sections' });
    const trigger = nav.querySelector<HTMLElement>('[data-nav-trigger]')!;
    fireEvent.click(trigger);
    const item = nav.querySelector('[data-nav-panel] a')!;
    expect(item).toBeTruthy();
    for (const el of [item, trigger]) {
      const classes = inheritedClasses(el, container.firstElementChild!);
      expect(classes).not.toContain('uppercase');
      expect(classes).not.toContain('tracking-wide');
    }
    const label = screen.getByText('Inventory', { selector: 'span' });
    expect(label.classList).toContain('uppercase');
  });
});
