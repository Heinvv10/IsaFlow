/**
 * D2 census group 4 (a): a failed response on the main load/action path now reaches the user. A 400 shows the
 * server's message, an empty 500 shows a plain sentence (never "Unexpected end of JSON input"), a 200 renders.
 * LEFT / NOT TESTED here: see the group report (best-effort lookups, adjacent-invoice navigation).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { creditNoteId: 'cn-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import PisScorePage from '../../../pages/accounting/afs/pis-score';
import DunningPage from '../../../pages/accounting/ar/dunning/index';
import AuditPacksPage from '../../../pages/accounting/audit-packs/index';
import BankReconListPage from '../../../pages/accounting/bank-reconciliation/index';
import CreditNotePage from '../../../pages/accounting/credit-notes/[creditNoteId]';
import { MSG, bad, boom, expectNoRawJsonError, ok, trio } from '../helpers/d2CensusG4';

void mockedApiFetchModule;
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const isPut = (init?: RequestInit) => init?.method === 'PUT';
const click = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));

const PIS = {
  fiscalYear: 2031, fiscalYearStart: '2031-03-01', fiscalYearEnd: '2032-02-28',
  employees: { beginning: 3, end: 4, average: 4, points: 4 }, turnover: { amount: 1000, points: 1 },
  thirdPartyLiabilities: { amount: 500, points: 1 }, shareholders: { count: 2, points: 2 }, totalScore: 8,
  allShareholdersAreDirectors: true, reportingRequirement: 'independent_review', requiredFramework: 'ifrs_sme',
  requiredCipcFiling: 'afs_required', dataUnavailable: [], calculatedAt: '2031-03-01',
};
const SETTINGS = { settings: { auto_send_enabled: false, min_outstanding_zar: 100 } };
const RECON = [{ id: 'r1', bankAccountId: 'b1', bankAccountName: 'D2 Cheque Account', statementDate: '2031-03-01', statementBalance: 10, glBalance: 10,
  reconciledBalance: 10, difference: 0, status: 'in_progress', startedBy: 'u', startedAt: '2031-03-01', createdAt: '2031-03-01', updatedAt: '2031-03-01', matchedCount: 1, unmatchedCount: 0 }];
const NOTE = { id: 'cn-1', creditNoteNumber: 'CN-D2', type: 'customer', clientId: 'c-1', clientName: 'Acme', creditDate: '2031-03-01', subtotal: 100,
  taxRate: 15, taxAmount: 15, totalAmount: 115, status: 'approved', createdAt: '2031-03-01' };

describe('afs/pis-score load', () => {
  trio({ name: 'PIS score', render: () => render(<PisScorePage />), match: u => u.includes('afs/pis-score'), data: PIS,
    plain: 'Could not load the PIS score - try again', success: /2031-03-01/ });
});

describe('ar/dunning auto-send toggle', () => {
  trio({ name: 'dunning toggle', render: () => render(<DunningPage />),
    match: (u, i) => u.includes('dunning/settings') && isPut(i), data: { settings: { auto_send_enabled: true, min_outstanding_zar: 777 } },
    others: u => (u.includes('dunning/settings') ? ok(SETTINGS) : u.includes('dunning/templates') ? ok({ templates: [] }) : undefined),
    drive: () => click(/^enable$/i), plain: 'Could not update the auto-send setting - try again', success: /R 777\.00/ });
});

describe('bank-reconciliation list load', () => {
  trio({ name: 'reconciliation list', render: () => render(<BankReconListPage />), match: u => u.includes('bank-reconciliations'), data: RECON,
    plain: 'Could not load the reconciliations - try again', success: /D2 Cheque Account/ });
});

describe('credit-notes detail: outstanding invoices in the apply modal', () => {
  trio({ name: 'apply modal invoices', render: () => render(<CreditNotePage />), match: u => u.includes('customer-invoices-list'),
    data: [{ id: 'i-1', invoice_number: 'INV-D2-777', invoice_date: '2031-03-01', total_amount: 500, amount_paid: 0 }],
    others: u => (u.includes('credit-notes?id=') ? ok(NOTE) : undefined),
    drive: () => click(/apply to invoice/i), plain: 'Could not load the outstanding invoices - try again', success: /INV-D2-777/ });
});

describe('audit-packs: auditor sessions', () => {
  const EXPORTS = { exports: [{ id: 'e-1', periodStart: '2031-01-01', periodEnd: '2031-01-31', status: 'ready', jeCount: 1, lineCount: 1,
    documentCount: 0, totalDebits: 1, totalCredits: 1, pdfSha256: null, error: null, requestedAt: '2031-02-01', builtAt: null }] };
  const SESSION = { id: 's-1', auditorEmail: 'auditor-d2@firm.co.za', issuedAt: '2031-02-01', expiresAt: '2031-03-01', revokedAt: null, lastUsedAt: null, useCount: 2 };
  const isList = (u: string) => u.endsWith('/audit-exports');
  const invite = async () => fireEvent.click(await screen.findByTitle('Invite auditor'));

  trio({ name: 'open invite drawer', render: () => render(<AuditPacksPage />), match: u => u.includes('/sessions'), data: { sessions: [SESSION] },
    others: u => (isList(u) ? ok(EXPORTS) : undefined), drive: invite,
    plain: 'Could not load the auditor sessions - try again', success: /auditor-d2@firm\.co\.za/ });

  describe('after creating a portal link the refresh failing is reported', () => {
    let gets = 0;
    const route = (mode: 'bad' | 'boom') => vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (isList(u)) return ok(EXPORTS);
      if (u.includes('/sessions') && init?.method === 'POST') return ok({ portalUrl: 'https://portal.example/p', accessToken: 't' });
      if (u.includes('/sessions')) return ++gets === 1 ? ok({ sessions: [] }) : mode === 'bad' ? bad() : boom();
      return ok({});
    });
    const run = async () => {
      gets = 0;
      render(<AuditPacksPage />);
      await invite();
      fireEvent.change(await screen.findByPlaceholderText('auditor@firm.co.za'), { target: { value: 'a@firm.co.za' } });
      await click(/create portal link/i);
    };
    it('400 shows the server message', async () => { route('bad'); await run(); expect(await screen.findByText(MSG)).toBeTruthy(); });
    it('empty 500 shows a plain sentence', async () => {
      route('boom'); await run();
      expect(await screen.findByText('Could not load the auditor sessions - try again')).toBeTruthy(); expectNoRawJsonError();
    });
  });

  describe('revoke', () => {
    const run = async (del: () => Response) => {
      vi.stubGlobal('confirm', () => true);
      vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (isList(u)) return ok(EXPORTS);
        if (u.includes('/sessions/') && init?.method === 'DELETE') return del();
        if (u.includes('/sessions')) return ok({ sessions: [SESSION] });
        return ok({});
      });
      render(<AuditPacksPage />);
      await invite();
      fireEvent.click(await screen.findByTitle('Revoke'));
    };
    it('400 shows the server message', async () => { await run(bad); expect(await screen.findByText(MSG)).toBeTruthy(); });
    it('empty 500 shows a plain sentence, not "Revoked"', async () => {
      await run(boom);
      expect(await screen.findByText('Could not revoke the session - try again')).toBeTruthy();
      expect(screen.queryByText('Revoked')).toBeNull(); expectNoRawJsonError();
    });
    it('a 200 says Revoked', async () => { await run(() => ok({})); expect(await screen.findByText('Revoked')).toBeTruthy(); });
  });
});
