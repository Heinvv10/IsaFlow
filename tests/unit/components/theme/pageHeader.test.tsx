/**
 * PageHeader (master plan §3b.3): one header for every page — title, breadcrumb or subtitle,
 * actions. That it reads in both themes is checked in a browser, by the axe and computed-style
 * contrast runs in tests/e2e/golden-paths/o-theme-contrast.spec.ts, not by class names here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FileText } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders the title as the page h1, with subtitle and actions', () => {
    render(<PageHeader icon={FileText} title="Tax Invoices" subtitle="All projects" actions={<button>New</button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Tax Invoices' })).toBeInTheDocument();
    expect(screen.getByText('All projects')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  it('renders a breadcrumb trail above the title, last crumb is the current page', () => {
    render(
      <PageHeader
        icon={FileText}
        title="Income Statement"
        breadcrumb={[{ label: 'Reports', href: '/accounting?tab=reports' }, { label: 'Income Statement' }]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/accounting?tab=reports');
    expect(within(nav).getByText('Income Statement')).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the backLink form used by existing pages', () => {
    render(<PageHeader icon={FileText} title="Quotes" backLink={{ label: 'Sales', href: '/accounting/sales' }} />);
    expect(screen.getByRole('link', { name: /Sales/ })).toHaveAttribute('href', '/accounting/sales');
  });

  it('puts the actions after the title, and renders no breadcrumb unless given one', () => {
    render(<PageHeader icon={FileText} title="Quotes" actions={<button>New quote</button>} />);
    const title = screen.getByRole('heading', { level: 1, name: 'Quotes' });
    const action = screen.getByRole('button', { name: 'New quote' });
    expect(title.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('puts the breadcrumb before the title', () => {
    render(<PageHeader icon={FileText} title="Trial Balance" breadcrumb={[{ label: 'Reports', href: '/r' }, { label: 'Trial Balance' }]} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const title = screen.getByRole('heading', { level: 1 });
    expect(nav.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('can drop the bottom margin for pages whose content block brings its own padding', () => {
    const { container } = render(<PageHeader icon={FileText} title="T" className="mb-0" />);
    expect((container.firstChild as HTMLElement).className).toContain('mb-0');
    expect((container.firstChild as HTMLElement).className).not.toContain('mb-6');
  });
});
