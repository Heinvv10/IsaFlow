// An export says what the report on screen ran on. The ledgers name the dates they ran on, not whatever the inputs
// have moved to since.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { typeDate } from '../helpers/dateFields';
import { gatePage, serve, settle } from '../helpers/reportDateGatePages';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), pathname: '/' }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1' } }) }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => <button type="button" onClick={() => onChange('s1', 'A')}>Pick supplier</button>,
}));

const textbox = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const exportButton = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe.each(['customer-ledger', 'supplier-ledger'])('%s CSV', (file) => {
  let blob: Blob | undefined;
  let filename = '';

  beforeEach(() => {
    blob = undefined;
    filename = '';
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:csv'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) { filename = this.download; });
  });

  const open = async () => {
    const page = gatePage(file);
    serve(page);
    const { default: Page } = await page.load();
    render(<Page />);
    await settle();
    return page;
  };
  const run = async () => {
    await gatePage(file).prepare!();
    await waitFor(() => expect(exportButton().disabled).toBe(false));
  };

  it('names the dates the report ran on, after the inputs have moved on', async () => {
    await open();
    typeDate(textbox('From'), '2026-02-03');
    typeDate(textbox('To'), '2026-02-27');
    await settle();
    await run();
    typeDate(textbox('From'), '2025-01-05');
    typeDate(textbox('To'), '2025-12-06');
    await settle();
    fireEvent.click(exportButton());
    await waitFor(() => expect(blob).toBeTruthy());
    expect(await blob!.text()).toContain('Period: 2026-02-03 to 2026-02-27');
    expect(filename).toMatch(/-2026-02-03-2026-02-27\.csv$/);
  });
});
