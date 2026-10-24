/**
 * PageHeader (master plan §3b.3): one header for every page — title, breadcrumb or subtitle,
 * actions — drawn from theme tokens so it reads in both themes (the navy band that kept a
 * dark title on a white page is gone).
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

  it('is drawn from theme tokens, with no hard-coded dark surface or fixed-colour title', () => {
    const { container } = render(<PageHeader icon={FileText} title="T" subtitle="S" />);
    const html = container.innerHTML;
    expect(html).toContain('bg-header-band');
    expect(html).toContain('text-ink');
    expect(html).toContain('text-ink-muted');
    expect(html).not.toMatch(/(?:^|[\s"])(?:bg-slate-9|from-slate-9|text-white(?:[\s"]|$))/);
    expect(html).not.toMatch(/(?:^|[\s"])text-slate-9/);
  });

  it('can drop the bottom margin for pages whose content block brings its own padding', () => {
    const { container } = render(<PageHeader icon={FileText} title="T" className="mb-0" />);
    expect((container.firstChild as HTMLElement).className).toContain('mb-0');
    expect((container.firstChild as HTMLElement).className).not.toContain('mb-6');
  });
});
