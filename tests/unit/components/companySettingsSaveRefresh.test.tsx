// Company settings (PR #1581): a save that moves the financial year start re-reads what only the server knows
// (the month the rebuilt periods use, the lock) WITHOUT replacing the form: an edit typed while the save runs
// survives, a failed re-read keeps the company on screen, and a partial-save error is never hidden by it.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CompanySettingsPage from '../../../pages/accounting/company-settings';
import { apiFetch } from '@/lib/apiFetch';
import { pickKit } from '../../helpers/kitSelect';

const active = vi.hoisted(() => ({ id: 'company-a' }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: active.id }, loading: false }), useCompanyRoleOrNull: () => 'owner',
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
let aLocked = false;                            // company-a's GET reports it locked by a posting
let rereadGate: Promise<void> = Promise.resolve(); // company-a's re-read (every GET of it after the first) waits for this

const yearOf = (m: number) => m === 6
  ? { fiscalYear: 2027, startDate: '2026-06-01', endDate: '2027-05-31', kind: 'normal' }
  : { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', kind: 'normal' };

beforeEach(() => {
  stored = 3; gets = 0; rereadFails = false; numbersFail = false; putGate = Promise.resolve(); rereadGate = Promise.resolve(); aLocked = false;
  active.id = 'company-a';
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const put = (init as RequestInit | undefined)?.method === 'PUT';
    if (u === '/api/accounting/companies?id=company-b') {
      // Company B: declares March, its periods run from January (the warning names both), editable.
      return Response.json({ success: true, data: { id: 'company-b', name: 'Other', financial_year_start: 3,
        financialYearStartLocked: false, financialYearStartActual: 1 } });
    }
    if (u.startsWith('/api/accounting/companies?')) {
      if (gets++ > 0) await rereadGate;
      if (gets > 1 && rereadFails) {
        await new Promise(r => setTimeout(r, 30)); // lands after the parallel PUTs have answered
        return Response.json({ success: false, error: { code: 'INTERNAL', message: 'db down' } }, { status: 500 });
      }
      return Response.json({ success: true, data: { id: 'company-a', name: 'Example', financial_year_start: stored,
        financialYearStartLocked: aLocked, financialYearStartLockReason: aLocked ? 'posted' : null, financialYearStartActual: stored } });
    }
    if (u === '/api/accounting/companies' && put) {
      await putGate;
      stored = Number((JSON.parse(String((init as RequestInit).body)) as { financialYearStart: number }).financialYearStart);
      return Response.json({ success: true, data: { id: 'company-a', name: 'Example', financial_year_start: stored } });
    }
    if (u.includes('financial-year-end-change')) {
      return Response.json({ success: true, data: { currentYear: yearOf(stored), history: [], undo: { changeId: null, refusals: [] } } });
    }
    if (u.startsWith('/api/accounting/company-documents')) return Response.json({ success: true, data: { items: [] } });
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

describe('the re-read of company A answers after the user switched to company B', () => {
  async function saveAThenSwitchToB() {
    let release!: () => void;
    rereadGate = new Promise(r => { release = r; });
    const view = render(<CompanySettingsPage />);
    await screen.findByText(/1 Mar 2026 to 28 Feb 2027/);
    await pickKit(combo('Financial Year Start Month'), 'Jun');
    fireEvent.click(save());
    await screen.findByText(SAVED);                        // A's re-read is now waiting at the gate
    active.id = 'company-b';
    view.rerender(<CompanySettingsPage />);
    await screen.findByText(B_WARNING);
    // A page error showing here would mask the one under test (setError keeps the first).
    expect(screen.queryByText(/could not (load (the )?(company|some|statutory)|refresh)/i), 'B loaded with a page error').toBeNull();
    return release;
  }
  const B_WARNING = 'Your fiscal periods run from January, but the declared financial year start is March. Choose January and save to align them.';

  it("A's answer is not merged into B", async () => {
    const release = await saveAThenSwitchToB();
    aLocked = true;                                         // A's answer would lock the field (and claims June)
    release();
    await waitFor(() => expect(gets).toBe(2));
    await new Promise(r => setTimeout(r, 50));
    expect(screen.getByText(B_WARNING), "B's fiscal fields took A's answer").toBeTruthy();
    expect(combo('Financial Year Start Month').getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByText(/Locked because journals have been posted/)).toBeNull();
  });

  it("A's failed re-read does not put its message in B's banner", async () => {
    rereadFails = true;
    const release = await saveAThenSwitchToB();
    release();
    await waitFor(() => expect(gets).toBe(2));
    await new Promise(r => setTimeout(r, 100));             // the failing re-read has answered by now
    expect(screen.queryByText(NOT_REFRESHED)).toBeNull();
    expect(screen.getByText(B_WARNING)).toBeTruthy();
  });
});
