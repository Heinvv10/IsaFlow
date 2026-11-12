/**
 * #1266 round 4 L1: when the creator tries to approve their own directive and the server refuses (403, four eyes), the
 * directives page shows the server's message, which says how to proceed, not a generic error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import TaxDirectivesPage from '@/../pages/payroll/tax-directives';
import { TaxDirectiveSelfApprovalError } from '@/modules/accounting/services/payroll/taxDirectiveApprover';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

// The service's own refusal text, so the page is tested against what the server really sends.
const REFUSAL = new TaxDirectiveSelfApprovalError().message;

describe('the directives page and a refused self-approval', () => {
  it('shows the server\'s 403 message with the way to proceed', async () => {
    expect(REFUSAL).toMatch(/ask another owner, admin or manager to approve it; or, .* cancel this directive and create it again/);
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
        return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: REFUSAL } }), { status: 403 });
      }
      return ok([{ id: 'd-1', employeeName: 'Wanda Test', employeeTaxNumber: null, directiveType: 'fixed_percentage', amount: 0,
        taxRate: 0.2, taxAmount: null, effectiveDate: '2026-03-01', status: 'pending' }]);
    });
    render(<TaxDirectivesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
  });
});
