/**
 * Round 4, item 8: the old Sage migration page, with nothing in its staging
 * tables, led with developer text naming the sage_* tables, and its Import
 * from Sage link sat below the fold. A client now meets the link first, and no
 * table name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import SageMigrationPage from '../../../pages/accounting/sage-migration/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const EMPTY = {
  accounts: { sageTotal: 0, mapped: 0, unmapped: 0, autoMapped: 0 },
  ledger: { sageTotal: 0, imported: 0, pending: 0, failed: 0, dateRange: { earliest: null, latest: null } },
  invoices: { sageTotal: 0, imported: 0, pending: 0, failed: 0 }, lastRuns: [],
};

describe('Sage migration page with nothing staged', () => {
  it('leads with Import from Sage and names no database table', async () => {
    script((u) => (u.includes('sage-migration') ? ok(EMPTY) : undefined));
    render(<SageMigrationPage />);
    const link = await screen.findByRole('link', { name: /Import from Sage/ });
    expect(link.getAttribute('href')).toBe('/accounting/migration/sage');
    expect(document.body.textContent).not.toMatch(/sage_accounts|sage_ledger_transactions|sage_supplier_invoices|sync tables|No Sage Data to Migrate/);
    // First in the page: before the staff pipeline's step cards.
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Import from Sage')).toBeLessThan(text.indexOf('Map Accounts'));
  });
});
