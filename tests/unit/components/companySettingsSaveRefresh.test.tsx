// Company settings (PR #1581): a save that moves the financial year start re-reads what only the server knows
// (the month the rebuilt periods use, the lock) WITHOUT replacing the form: an edit typed while the save runs
// survives, a failed re-read keeps the company on screen, and a partial-save error is never hidden by it.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CompanySettingsPage from '../../../pages/accounting/company-settings';
import { apiFetch } from '@/lib/apiFetch';
import { pickKit } from '../../helpers/kitSelect';

vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'company-a' }, loading: false }), useCompanyRoleOrNull: () => 'owner',
}));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { tab: 'general' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
useApiJsonOverMock();

const SAVED = 'Changes saved successfully';
const PARTIAL = 'Company details saved, but some settings could not be saved - try again';
const NOT_REFRESHED = /could not refresh/;
let stored = 3;                                // financial_year_start (and the periods' month) in the "database"
let gets = 0;                                  // company GETs answered so far
let rereadFails = false;                       // every company GET after the first answers 500
let numbersFail = false;                       // the document-numbers PUT answers 500
let putGate: Promise<void> = Promise.resolve(); // the company PUT waits for this

const yearOf = (m: number) => m === 6
  ? { fiscalYear: 2027, startDate: '2026-06-01', endDate: '2027-05-31', kind: 'normal' }
  : { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', kind: 'normal' };

beforeEach(() => {
  stored = 3; gets = 0; rereadFails = false; numbersFail = false; putGate = Promise.resolve();
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const put = (init as RequestInit | undefined)?.method === 'PUT';
    if (u.startsWith('/api/accounting/companies?')) {
      if (gets++ > 0 && rereadFails) {
        await new Promise(r => setTimeout(r, 30)); // lands after the parallel PUTs have answered
        return Response.json({ success: false, error: { code: 'INTERNAL', message: 'db down' } }, { status: 500 });
      }
      return Response.json({ success: true, data: { id: 'company-a', name: 'Example', financial_year_start: stored,
        financialYearStartLocked: false, financialYearStartActual: stored } });
    }
    if (u === '/api/accounting/companies' && put) {
      await putGate;
      stored = Number((JSON.parse(String((init as RequestInit).body)) as { financialYearStart: number }).financialYearStart);
      return Response.json({ success: true, data: { id: 'company-a', name: 'Example', financial_year_start: stored } });
    }
    if (u.includes('financial-year-end-change')) {
      return Response.json({ success: true, data: { currentYear: yearOf(stored), history: [], undo: { changeId: null, refusals: [] } } });
    }
    if (u.includes('type=document-numbers')) {
      if (put && numbersFail) return new Response('{}', { status: 500 });
      return Response.json({ success: true, data: [{ documentType: 'invoice', prefix: 'INV-', nextNumber: 1 }] });
    }
    return Response.json({ success: true, data: [] });
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const save = () => screen.getByRole('button', { name: /Save Changes/ });
const combo = (name: string) => screen.getByRole('combobox', { name });
async function pickJuneAndSave() {
  render(<CompanySettingsPage />);
  await screen.findByText(/1 Mar 2026 to 28 Feb 2027/);
  await pickKit(combo('Financial Year Start Month'), 'Jun');
  fireEvent.click(save());
}

it('an edit typed while the save runs survives the re-read', async () => {
  let release!: () => void;
  putGate = new Promise(r => { release = r; });
  await pickJuneAndSave();
  await pickKit(combo('Default Currency'), /USD/); // typed while the company PUT is in flight
  release();
  await screen.findByText(SAVED);
  await screen.findByText(/1 Jun 2026 to 31 May 2027/);
  expect(gets, 'the company was not re-read').toBe(2);
  expect(combo('Default Currency').textContent, 'the re-read replaced the edit').toMatch(/USD/);
  expect(combo('Financial Year Start Month').textContent).toBe('Jun');
  expect(screen.queryByText(/declared financial year start/)).toBeNull();
});

it('a failed re-read keeps the company on screen beside the success banner, and says it could not refresh', async () => {
  rereadFails = true;
  await pickJuneAndSave();
  await screen.findByText(SAVED);
  await screen.findByText(NOT_REFRESHED);
  expect(screen.queryByText('No company configured')).toBeNull();
  expect(combo('Financial Year Start Month').textContent).toBe('Jun');
  expect(screen.getByText(SAVED)).toBeTruthy();
});

it('a partial save that moves the month: the partial-save error and the re-read coexist', async () => {
  numbersFail = true;
  await pickJuneAndSave();
  await screen.findByText(PARTIAL);
  await screen.findByText(/1 Jun 2026 to 31 May 2027/);
  expect(gets).toBe(2);
  expect(screen.queryByText(/declared financial year start/)).toBeNull();
  expect(screen.getByText(PARTIAL)).toBeTruthy();
});

it('a failed re-read never replaces a partial-save error', async () => {
  numbersFail = true;
  rereadFails = true;
  await pickJuneAndSave();
  await screen.findByText(PARTIAL);
  await new Promise(r => setTimeout(r, 100)); // the failing re-read has answered by now
  expect(gets).toBe(2);
  expect(screen.getByText(PARTIAL)).toBeTruthy();
  expect(screen.queryByText(NOT_REFRESHED)).toBeNull();
  expect(screen.queryByText('No company configured')).toBeNull();
});
