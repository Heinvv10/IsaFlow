import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NavLinksBlock } from '@/components/layout/NavLinksBlock';
import { mostSpecificActiveHref } from '@/components/accounting/navSections/activeTab';

// Specific link FIRST: a "last match wins" implementation would pick Reconcile.
const LINKS = [
  { label: 'Import Statement', href: '/accounting/bank-reconciliation/import' },
  { label: 'Reconcile', href: '/accounting/bank-reconciliation' },
];
const cls = (active: boolean) => (active ? 'on' : 'off');

describe('NavLinksBlock', () => {
  it('renders each link and a separator after them', () => {
    const { container } = render(
      <NavLinksBlock links={LINKS} asPath="/accounting" onNav={vi.fn()} linkClassName={cls} separatorClassName="sep" />,
    );
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(container.querySelectorAll('.sep')).toHaveLength(1);
    const last = container.lastElementChild as HTMLElement;
    expect(last.className).toBe('sep');
    expect(last.previousElementSibling?.tagName).toBe('A');
  });

  it('renders nothing, separator included, without links', () => {
    for (const links of [undefined, []]) {
      const { container } = render(
        <NavLinksBlock links={links} asPath="/accounting" onNav={vi.fn()} linkClassName={cls} separatorClassName="sep" />,
      );
      expect(container.innerHTML).toBe('');
    }
  });

  it('calls onNav when a link is clicked', () => {
    const onNav = vi.fn();
    render(<NavLinksBlock links={LINKS} asPath="/accounting" onNav={onNav} linkClassName={cls} separatorClassName="sep" />);
    fireEvent.click(screen.getByRole('link', { name: 'Reconcile' }));
    expect(onNav).toHaveBeenCalledTimes(1);
  });

  it('highlights only the most specific sibling', () => {
    render(
      <NavLinksBlock links={LINKS} asPath="/accounting/bank-reconciliation/import" onNav={vi.fn()} linkClassName={cls} separatorClassName="sep" />,
    );
    expect(screen.getByRole('link', { name: 'Import Statement' }).className).toBe('on');
    expect(screen.getByRole('link', { name: 'Reconcile' }).className).toBe('off');
  });

  it('still highlights the parent on its own page', () => {
    render(<NavLinksBlock links={LINKS} asPath="/accounting/bank-reconciliation" onNav={vi.fn()} linkClassName={cls} separatorClassName="sep" />);
    expect(screen.getByRole('link', { name: 'Reconcile' }).className).toBe('on');
    expect(screen.getByRole('link', { name: 'Import Statement' }).className).toBe('off');
  });
});

describe('mostSpecificActiveHref', () => {
  it('is null when nothing matches', () => {
    expect(mostSpecificActiveHref(LINKS.map(l => l.href), '/accounting/customers')).toBeNull();
  });
});
