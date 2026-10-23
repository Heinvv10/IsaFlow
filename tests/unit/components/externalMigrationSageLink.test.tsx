/**
 * The Xero / QuickBooks / Pastel import page sends a Sage move to the
 * file-upload Migration Wizard's Sage opener — CSV / Excel exported from Sage,
 * not a sign-in to Sage — and the page it links to exists.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/migration/ExternalMigrationWizard', () => ({ ExternalMigrationWizard: () => null }));

import ExternalMigrationPage from '../../../pages/accounting/migration/external';

afterEach(() => { cleanup(); });

describe('external migration page: Moving from Sage?', () => {
  it('links Import from Sage to the Migration Wizard\'s Sage opener', () => {
    render(<ExternalMigrationPage />);
    const link = screen.getByText('Import from Sage').closest('a')!;
    expect(link.getAttribute('href')).toBe('/accounting/migration#sage');
    expect(existsSync(join(process.cwd(), 'pages/accounting/migration/index.tsx'))).toBe(true);
  });

  it('describes exporting files from Sage, not connecting or signing in', () => {
    render(<ExternalMigrationPage />);
    const note = screen.getByText(/Moving from Sage\?/);
    expect(note.textContent).toMatch(/CSV or Excel/);
    expect(note.textContent).not.toMatch(/sign in|sign-in|password|connect/i);
  });
});
